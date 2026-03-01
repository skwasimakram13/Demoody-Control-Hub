const { autoUpdater } = require('electron-updater');
const { app } = require('electron');

app.whenReady().then(() => {
    autoUpdater.logger = console;
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'skwasimakram13',
        repo: 'Demoody-Control-Hub'
    });

    autoUpdater.checkForUpdates().then(res => {
        console.log("Success:", res);
        app.quit();
    }).catch(err => {
        console.error("Error:", err);
        app.quit();
    });
});
