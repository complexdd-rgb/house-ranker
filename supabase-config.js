window.HOUSE_RANKER_SUPABASE = Object.freeze({
  url: 'https://dlftrldigxgwacorklzj.supabase.co',
  publishableKey: 'sb_publishable_VdDNB58jGf7qbBOK8M05zw_RejtjSpW'
});

// Phase 2 is loaded after the stable Phase 1 app so it can progressively
// enhance the existing add-house, auth and ranking flows without a build step.
window.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = 'epc.css?v=2';
  document.head.appendChild(style);

  const script = document.createElement('script');
  script.src = 'epc.js?v=2';
  document.body.appendChild(script);
});
