if (navigator.userAgentData?.platform === 'Android'
    || /Android|iPad|iPhone|iPod/.test(navigator.userAgent)
    || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
    const manifest = document.querySelector('link[rel="manifest"]');
    manifest.href = new URL(manifest.dataset.mobileManifest, document.baseURI).href;
}
