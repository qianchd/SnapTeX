if ('serviceWorker' in navigator) {
    const preparationDelay = 1500;
    const status = document.getElementById('offline-status');
    const setStatus = (text, title = text) => {
        if (!status) return;
        status.textContent = text;
        status.title = title;
        status.hidden = !text;
    };
    const waitForActivation = worker => new Promise((resolve, reject) => {
        if (!worker || worker.state === 'activated') {
            resolve();
            return;
        }
        if (worker.state === 'redundant') {
            reject(new Error('Service worker installation failed.'));
            return;
        }
        worker.addEventListener('statechange', () => {
            if (worker.state === 'activated') resolve();
            if (worker.state === 'redundant') reject(new Error('Service worker installation failed.'));
        });
    });
    const register = async () => {
        setStatus('Preparing offline use...');
        try {
            const registration = await navigator.serviceWorker.register(new URL('service-worker.js', window.location.href));
            await waitForActivation(registration.installing ?? registration.waiting ?? registration.active);
            await navigator.serviceWorker.ready;
            setStatus('Offline ready', 'All SnapTeX application resources are available offline.');
        } catch (error) {
            setStatus('');
            console.warn('[SnapTeX] PWA service worker registration failed.', error);
        }
    };
    window.addEventListener('load', () => {
        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(() => void register(), { timeout: preparationDelay });
        } else {
            window.setTimeout(() => void register(), preparationDelay);
        }
    });
}
