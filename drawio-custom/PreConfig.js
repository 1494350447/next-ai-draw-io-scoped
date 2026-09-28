/* 生成物，不要手改 —— 由 tools/gen_drawio_custom.py 生成（改模板后重跑 build）。
 *
 * 这是 drawio 的运行时配置入口（webapp: js/PreConfig.js），在应用脚本之前执行。
 * 本文件以只读方式挂进容器，顶掉镜像 entrypoint 每次启动时重写的那一份，
 * 从而在重启/重建后仍然带着下面这段插件注入。
 *
 * 与 entrypoint 版本的差异：它把 DRAWIO_* 写成硬编码值，这里改成从本脚本自身的
 * <script src> 反推部署前缀，所以同一份文件在 "/" 与 "/draw/" 前缀下都成立，
 * 也不依赖 DRAWIO_BASE_URL 环境变量。
 */
(function () {
  try {
    var s = document.createElement('meta');
    // CSP 里只有单引号，所以这里用双引号包裹，避免再套一层转义。
    s.setAttribute('content', "default-src 'self'; script-src 'self' https://storage.googleapis.com https://apis.google.com https://docs.google.com https://code.jquery.com 'unsafe-inline'; connect-src 'self' http://localhost:3000 https://*.dropboxapi.com https://api.trello.com https://api.github.com https://raw.githubusercontent.com https://*.googleapis.com https://*.googleusercontent.com https://graph.microsoft.com https://*.1drv.com https://*.sharepoint.com https://gitlab.com https://*.google.com https://fonts.gstatic.com https://fonts.googleapis.com; img-src * data:; media-src * data:; font-src * about:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; frame-src 'self' https://*.google.com;");
    s.setAttribute('http-equiv', 'Content-Security-Policy');
    var t = document.getElementsByTagName('meta')[0];
    t.parentNode.insertBefore(s, t);
  } catch (e) {} // ignore
})();

// 部署前缀：PreConfig.js 由 mxscript 以相对路径 'js/PreConfig.js' 注入，
// 从 document.scripts 里找它自己的 URL，去掉尾部 js/PreConfig.js 即得前缀。
var __drawioBase = (function () {
    try {
        var list = document.scripts || [];
        for (var i = 0; i < list.length; i++) {
            var m = /^(.*)\/js\/PreConfig\.js(?:[?#]|$)/.exec(list[i].src || '');
            if (m) return m[1];
        }
    } catch (e) {} // ignore
    return location.origin;
})();

window.DRAWIO_SERVER_URL = __drawioBase + '/';
window.DRAWIO_BASE_URL = __drawioBase;
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

// ===== ai-scope-adapter v1 =====
// 作用域编辑适配层（选区读取 + 可调用动作 + 只改选中元素的写回）。
// 它只做适配，不含业务逻辑；宿主（next-ai-draw-io）通过 embed 的 postMessage
// 用 {action:'invokeAction', actionName:'<名字>'} 调用里面的动作。
// 注入时机早于 Draw 定义，插件自己会轮询等 Draw.loadPlugin（见 drawio-custom/plugins/ai-scope.js）。
// AI_SCOPE_ENDPOINT 是 next-ai-draw-io 的局部编辑 API 端点；CSP 的 connect-src
// 已经同步放行它的 origin，否则插件里的 fetch 会被浏览器静默掐掉。
window.AI_SCOPE_ENDPOINT = "http://localhost:3000";
window.ALLOW_CUSTOM_PLUGINS = true; // 走 ?plugins= 入口时的前置开关；本注入不依赖它，留作备用
(function () {
    try {
        var s = document.createElement('script');
        // 带内容指纹的 URL（?v=<插件 sha256 前 8 位>）：插件换内容 → URL 变 → 浏览器重新拉。
        // 起因（实测）：Tomcat 给静态文件只发 ETag/Last-Modified、**不发 Cache-Control**，
        // 浏览器按启发式缓存就把旧插件一直用下去 —— 我们删掉的功能在用户页面上"还在"。
        // 指纹由 render_preconfig() 从插件文件现算，所以改了插件要重跑 build（check 会提醒）。
        s.src = window.AI_SCOPE_PLUGIN_URL || (__drawioBase + '/plugins/custom/ai-scope.js?v=5f127828');
        s.async = false;
        (document.head || document.getElementsByTagName('head')[0]).appendChild(s);
    } catch (e) {} // ignore
})();
