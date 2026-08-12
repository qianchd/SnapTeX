window.snaptexPreviewMessageQueue = [];
window.snaptexPreviewBridge = {
    postMessage(message) {
        if (window.snaptexStandaloneHost) {
            window.snaptexStandaloneHost.handlePreviewMessage(message);
        } else {
            window.snaptexPreviewMessageQueue.push(message);
        }
    }
};
