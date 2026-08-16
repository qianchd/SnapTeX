if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
        const scriptUrl = new URL('service-worker.js', window.location.href);
        try {
            const response = await fetch(scriptUrl, { cache: 'no-store' });
            if (!response.ok) {
                const registration = await navigator.serviceWorker.getRegistration('./');
                await registration?.unregister();
                return;
            }
            await navigator.serviceWorker.register(scriptUrl);
        } catch (error) {
            console.warn('[SnapTeX] PWA service worker registration failed.', error);
        }
    });
}
