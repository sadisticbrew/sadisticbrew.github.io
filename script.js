document.addEventListener('DOMContentLoaded', () => {

    // Smooth scrolling for anchor links
    const links = document.querySelectorAll('nav ul li a[href^="#"]');
    links.forEach(link => {
        link.addEventListener('click', function (e) {
            e.preventDefault();
            const targetId = this.getAttribute('href');
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                targetElement.scrollIntoView({
                    behavior: 'smooth'
                });
            }
        });
    });

    // Active link highlighting on scroll (simple version)
    const sections = document.querySelectorAll('main section');
    const navLi = document.querySelectorAll('nav ul li a');

    window.addEventListener('scroll', () => {
        let current = '';
        sections.forEach(section => {
            const sectionTop = section.offsetTop;
            if (pageYOffset >= sectionTop - 100) { // Adjust offset as needed
                current = section.getAttribute('id');
            }
        });

        navLi.forEach(a => {
            a.classList.remove('active');
            if (a.getAttribute('href').includes(current)) {
                a.classList.add('active');
            }
        });
    });


    // Set current year in footer
    const currentYearElement = document.getElementById('currentYear');
    if (currentYearElement) {
        currentYearElement.textContent = new Date().getFullYear();
    }

    // Simple Intersection Observer for fade-in animations on scroll (optional, for sections other than hero)
    const animatedElements = document.querySelectorAll('section > *:not(#hero .animated-text):not(#hero .animated-text-delay)');

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('fade-in-visible');
                observer.unobserve(entry.target); // Optional: stop observing after animation
            }
        });
    }, { threshold: 0.1 }); // Trigger when 10% of the element is visible

    animatedElements.forEach(el => {
        el.classList.add('fade-in-hidden'); // Initial state for observer
        observer.observe(el);
    });
});

// Add this to your CSS for the general fade-in effect for sections
/*
.fade-in-hidden {
    opacity: 0;
    transform: translateY(30px);
    transition: opacity 0.8s ease-out, transform 0.8s ease-out;
}

.fade-in-visible {
    opacity: 1;
    transform: translateY(0);
}
*/
// If you uncomment the above CSS for .fade-in-hidden and .fade-in-visible,
// also uncomment the observer part in script.js if you want general section fade-ins.
// For now, the hero text animation is handled separately.