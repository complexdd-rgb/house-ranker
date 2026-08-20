(() => {
  let checkedThisSession = false;

  async function retryLegacyConnectivitySetup() {
    if (checkedThisSession || !cloud?.session || !cloud?.client || !window.houseRankerConnectivity) return;
    checkedThisSession = true;

    await window.houseRankerConnectivity.hydrateConnectivityMetadata();
    const waiting = state.properties.filter(property => !property.demo && property.connectivity?.status === 'needs_api_keys');
    if (!waiting.length) return;

    for (const property of waiting.slice(0, 3)) {
      const result = await window.houseRankerConnectivity.enrichPropertyConnectivity(property.id, { quiet: true });
      if (!result?.ok || result.status === 'needs_api_keys') break;
    }

    await window.houseRankerConnectivity.hydrateConnectivityMetadata();
  }

  setTimeout(() => retryLegacyConnectivitySetup(), 12000);
  setTimeout(() => retryLegacyConnectivitySetup(), 42000);

  window.houseRankerConnectivityRetry = { retryLegacyConnectivitySetup };
})();
