(function() {
  try {
	    var s = document.createElement('meta');
	    s.setAttribute('content', 'default-src \'self\'; script-src \'self\' https://storage.googleapis.com https://apis.google.com https://docs.google.com https://code.jquery.com \'unsafe-inline\'; connect-src \'self\' https://*.dropboxapi.com https://api.trello.com https://api.github.com https://raw.githubusercontent.com https://*.googleapis.com https://*.googleusercontent.com https://graph.microsoft.com https://*.1drv.com https://*.sharepoint.com https://gitlab.com https://*.google.com https://fonts.gstatic.com https://fonts.googleapis.com; img-src * data:; media-src * data:; font-src * about:; style-src \'self\' \'unsafe-inline\' https://fonts.googleapis.com; frame-src \'self\' https://*.google.com;');
	    s.setAttribute('http-equiv', 'Content-Security-Policy');
 	    var t = document.getElementsByTagName('meta')[0];
      t.parentNode.insertBefore(s, t);
  } catch (e) {} // ignore
})();
window.DRAWIO_SERVER_URL = '';
window.DRAWIO_BASE_URL = 'http://localhost:8080';
window.DRAWIO_VIEWER_URL = '';
window.DRAWIO_LIGHTBOX_URL = '';
window.DRAW_MATH_URL = 'math4/es5';
window.EXPORT_URL = null;
window.DRAWIO_CONFIG = null;
urlParams['sync'] = 'manual'; //Disable Real-Time
urlParams['db'] = '0'; //dropbox
urlParams['gh'] = '0'; //github
urlParams['tr'] = '0'; //trello
urlParams['gapi'] = '0'; //Google Drive
urlParams['od'] = '0'; //OneDrive
urlParams['gl'] = '0'; //Gitlab

// ===== [s1-spike] AI 作用域编辑适配插件 =====
// 实测结论：这个 drawio 版本里 ?plugins=xxx.js 并不会加载任意插件——
//   App.js:1041  !ALLOW_CUSTOM_PLUGINS && !App.isBuiltInPlugin(...) → console 'Unknown plugin' 直接跳过；
//   且插件列表来自 mxSettings.getPlugins() / ?p=<registryKey>（App.js:993/1015），不是 URL 里的路径。
// 自托管的官方定制入口就是本文件：打开自定义插件开关，再把适配脚本注入页面。
// 插件自身会轮询等 Draw.loadPlugin 就绪，所以这里不必关心注入时机。
window.ALLOW_CUSTOM_PLUGINS = true;
(function () {
    try {
        var s = document.createElement('script');
        s.src = window.AI_SCOPE_PLUGIN_URL || 'plugins/ai-scope.js';
        s.async = false;
        (document.head || document.getElementsByTagName('head')[0]).appendChild(s);
    } catch (e) {} // ignore
})();
