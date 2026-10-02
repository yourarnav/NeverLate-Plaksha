const toast = document.querySelector('.toast');
let toastTimer;

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }

  const label = button.querySelector('.copy-label, b');
  const original = label ? label.textContent : '';
  if (label) label.textContent = 'Copied';

  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
  setTimeout(() => { if (label) label.textContent = original; }, 1600);
}

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', () => copyText(button.dataset.copy, button));
});

// IntersectionObserver for scroll-reveal animations
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('revealed');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.10 });

document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));

// Interactive Checkbox Demo in Mock Popover
const checkBoxes = document.querySelectorAll('[data-interactive-check]');
const mockBadge = document.querySelector('.mock-badge');

checkBoxes.forEach((box) => {
  box.addEventListener('click', (e) => {
    e.stopPropagation();
    const item = box.closest('.mock-item');
    if (!item) return;

    const isNowDone = !box.classList.contains('checked');
    box.classList.toggle('checked', isNowDone);
    item.classList.toggle('is-completed', isNowDone);

    const title = item.querySelector('.mock-item-title');
    if (title) title.classList.toggle('struck', isNowDone);

    const pill = item.querySelector('.mock-pill');
    if (pill) {
      if (isNowDone) {
        pill.dataset.prevClass = pill.className;
        pill.dataset.prevText = pill.textContent;
        pill.className = 'mock-pill pill-done';
        pill.textContent = 'Completed';
      } else {
        pill.className = pill.dataset.prevClass || 'mock-pill pill-calm';
        pill.textContent = pill.dataset.prevText || 'Upcoming';
      }
    }

    // Recompute badge count
    if (mockBadge) {
      const activeCount = document.querySelectorAll('.mock-item:not(.is-completed)').length;
      mockBadge.textContent = activeCount;
    }
  });
});
