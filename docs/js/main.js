/* bucket-no-more docs — shared client behaviour:
   - Mermaid.js init with a matching dark theme
   - highlight.js init for code blocks
   - mobile sidebar toggle
   - active nav-link highlighting based on the current path */

(function () {
  'use strict';

  // ---- Mermaid diagrams ----
  if (window.mermaid) {
    window.mermaid.initialize({
      startOnLoad: true,
      theme: 'base',
      themeVariables: {
        background: '#161b22',
        primaryColor: '#1c2330',
        primaryBorderColor: '#2dd4bf',
        primaryTextColor: '#e6edf3',
        lineColor: '#8b7cf6',
        secondaryColor: '#1c2330',
        tertiaryColor: '#0d1117',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: '14px',
      },
      sequence: { useMaxWidth: true, mirrorActors: false },
      flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
    });
  }

  // ---- Syntax highlighting ----
  if (window.hljs) {
    document.querySelectorAll('pre code').forEach(function (block) {
      window.hljs.highlightElement(block);
    });
  }

  // ---- Mobile sidebar toggle ----
  var toggle = document.querySelector('.menu-toggle');
  var sidebar = document.querySelector('.sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', function () {
      sidebar.classList.toggle('open');
    });
    document.querySelectorAll('.sidebar a').forEach(function (a) {
      a.addEventListener('click', function () { sidebar.classList.remove('open'); });
    });
  }

  // ---- Active nav link ----
  var here = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.sidebar a').forEach(function (a) {
    var target = a.getAttribute('href');
    if (!target) return;
    var leaf = target.split('/').pop();
    if (leaf === here) a.classList.add('active');
  });
})();
