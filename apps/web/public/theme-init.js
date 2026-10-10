// Applies the saved theme before the app renders, so dark mode doesn't flash light (see src/lib/theme.ts).
(function () {
  var pref = null;
  try {
    pref = localStorage.getItem('joybot.theme');
  } catch (e) {}
  var dark = pref === 'dark' || (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
