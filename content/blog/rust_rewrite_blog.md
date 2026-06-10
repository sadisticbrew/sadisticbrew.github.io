+++
date = '2026-06-10T18:40:40+05:30'
draft = false
title = "Why I didn't rewrite my eBPF tracer in Rust"
+++

I spent 3 days learning rust.

Not because I needed to. Because I was angry at a ring buffer. My eBPF based X-ray for compiled binaries, Muon, had been humming along fine until I turned on memory tracing; and suddenly the kernel was throwing 350,000 events per second at a 64MB buffer that couldn't empty fast enough. The Go garbage collector kept pausing. Events were dropping. And I was certain the fix was to burn the whole userspace down and rewrite it in Rust.

I was so wrong.

---

## Before the temptation

Before diving into why the temptation to rewrite it in rust was there, let me discuss what went wrong. So when you make eBPF based tracing tools, the sheer amount of events the kernel produces can overwhelm your tracing tool. I mitigated some of this by in-kernel filtering by PIDs -- only the events from the PIDs I was interested in (i.e the process tree to which muon was attached) were processed by Muon. It was a simple if check like this: 

```c
__u32 pid = bpf_get_current_pid_tgid() >> 32;
if (!bpf_map_lookup_elem(&tracked_pids, &pid)) return 0;
```

this simple snippet of code was in every tracepoint handler in the kernel side code and kept the number of events/sec managable UNTIL I got into the territory of kernel level memory tracing.\
\
When I started tracing memory accesses, the number of events increased exponentially. Unlike process creation or network connections, memory activity occurs constantly. A single process can generate hundreds of thousands of memory-related events per second, turning what was previously a manageable stream into a firehose. The eBPF ring buffer can only get so large before it starts to drop events, and at that point, the kernel side code starts to overwhelm my tracing tool.\
\
In my particular case, the ring buffer was only 64MB. On surface it seems huge amount of memory but when you are tracing a process that is producing 300k-500k events per second, that fills up almost instantly. My event struct was as follows:

```c
// Single event type shared across all probes. The union avoids over-allocating
// for small events (alloc_data) vs large ones (fname). Userspace dispatches on `type`.
struct event {
    __u32 pid;
    __u32 type;   // 0=exec, 1=openat, 2=exit, 3=connect, 4=mmap/munmap, 5=brk
    __u64 timestamp;
    char comm[16];
    union {
        char fname[256];               // for exec / openat
        unsigned char raw_addr[128];   // raw sockaddr bytes for connect (decoded in userspace)
        struct alloc_event alloc_data; // for mmap, munmap, brk
    } data;
};
```

this structs takes a maximum of 288 bytes of memory, at ~350k events/sec that is ~100MB/s of data. and the ring buffer fills up almost instantly. I partially mitigated this by calculating the amount of memory needed for munmap/brk/mmap and allocating that much memory upfront. The below code avoids reserving 288 bytes for every event when most are smaller.

```c
size_t reserve_size = offsetof(struct event, data) + sizeof(struct alloc_event);
struct event *e = bpf_ringbuf_reserve(&events, reserve_size, 0);

```

I also did userspace facing optimizations that reduces allocations and reuses allocted memory by using object pools in Go userspace code. But even with those optimizations I only reached a peak of around 450k events/sec per goroutine. Spinning up multiple goroutines for high number of events/sec is not feasible because the ring buffer is -- by design -- single-reader, so more goroutines just mean more lock contention, not more throughput. The problem was garbage collection pauses, context switching and hidden allocations done by cilium/ebpf library.

---
## The solutions

### First thoughts

I was thinking of rewriting the hot paths of Muon in Rust and using CGO to communicate between them. My bottleneck is in userspace. No matter how optimized the eBPF ring buffer draining and parsing into structs is in Go, there is a limit to what is achievable with a single goroutine.

BUT as I researched whether CGO was the correct design choice, I found a critical flaw. I was assuming that Rust is faster than Go and therefore Rust + Go would be faster than just Go.

The context switch: Go uses a custom scheduler with lightweight goroutines (M:N scheduling) and continuous, resizable stacks. Rust (via C FFI) uses standard OS threads and C-style stacks.

The tollbooth: Every time the CGO boundary is crossed, Go has to lock the thread, switch stack contexts, and do a bunch of bookkeeping to ensure the garbage collector doesn't free memory that Rust is currently using.

A CGO call takes roughly 50 to 100 nanoseconds. If I try to pass 450,000 events individually across that boundary every second, I could spend up to 45 milliseconds per second (nearly 5% of a CPU core) just paying the tollbooth fee before Rust even parses a single byte.

Hence, CGO was off the table.

---

The bottleneck was userspace. Even small copies and context switches count at high ingestion rates.

In the end, there were two paths.

#### * Path 0: The complete Rust rewrite

If I want to completely eliminate GC pauses and context-switching overhead, I move the entire userspace to Rust using aya and eventually maybe the kernel side too.

The win: Zero-copy parsing from the ring buffer directly into Rust structs. A single, unified build process (`cargo build`). Total control over memory layout.

The cost: I need to rewrite my state manager, Bubble Tea TUI (using something like ratatui), and manage memory lifetimes manually.

#### * Path 1: Pushing Go to the absolute edge (First Principles)

Before abandoning Go, I can bypass the cilium/ebpf reader abstractions. cilium/ebpf allocates memory and uses interfaces under the hood, which creates GC pressure.

The win: I keep my entire Go UI and build system.

The method: I write my own raw `mmap` reader in Go. I extract the ring buffer file descriptor, use `syscall.Mmap` to map the memory pages directly into Go, and use `unsafe.Pointer` to cast those raw bytes directly into my `ParsedEvent` structs with zero allocations and zero copies. It requires writing highly unsafe Go code, but it teaches me exactly how the Linux kernel shares memory with userspace.

---

To choose which path to take, I need to look at the concrete numbers and figure out where the ceiling actually is.

The bottleneck in high-throughput observability isn't just "the language". It is memory allocations (garbage collection) and memory bandwidth (cache misses).

> Numbers based on published benchmarks and reports from similar systems, a carefully written mmap-based Go reader should be capable of processing several million events per second per core, while a comparable Rust implementation may achieve somewhat higher throughput.

1. Standard Go (cilium/ebpf package): ~400k - 600k events/sec.

   As I discovered, the library allocates interfaces, creates slices, and uses reflection under the hood. The Go garbage collector kicks in, pauses threads, and the ring buffer overflows.

2. Raw Go (`syscall.Mmap` + `unsafe.Pointer`): ~2M - 5M events/sec (per core).

   If I bypass the libraries and read the raw memory pages directly into pre-allocated struct pools without triggering a single GC allocation, Go is quite fast. At that point I'm mostly bound by the speed of the CPU's L1/L2 cache and memory bus.

3. Pure Rust (aya): ~4M - 8M events/sec (per core).

   Rust has no GC and guarantees memory safety at compile time. It will probably be somewhat faster than raw Go because it doesn't have the Go runtime running in the background, but at this level both languages start running into the physical limits of hardware memory bandwidth.

I decided to go with the second path because it's a first-principles flex and because a Rust rewrite feels suspiciously like a yak shave. I have still not yet reached the limits of Go.

The real lesson wasn't about Go vs Rust. It was that I hadn't actually measured where my bottleneck was. I assumed "Go is slow" when the truth was "my Go code was doing unnecessary work."
