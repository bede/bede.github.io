// Dark mode toggle. Initial theme is applied by the inline <head> script;
// this only wires the button and persists the choice to localStorage.
(function () {
  var root = document.documentElement;

  function apply(dark) {
    root.classList.toggle('dark', dark);
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
  }

  var btn = document.querySelector('.theme-toggle');
  if (btn) {
    btn.addEventListener('click', function () {
      apply(!root.classList.contains('dark'));
    });
  }

  // Follow the OS setting live, but only until the user makes an explicit choice.
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', function (e) {
    try { if (localStorage.getItem('theme')) return; } catch (err) {}
    root.classList.toggle('dark', e.matches);
  });
})();
