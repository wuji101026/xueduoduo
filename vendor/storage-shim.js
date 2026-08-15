/* 安全存储垫片：当 localStorage / sessionStorage 不可用（如以 file:// 直接打开、隐私模式、部分浏览器设置）时，
   自动降级为内存存储，避免访问抛 SecurityError 导致整个应用白屏。可用时保持原生行为（无副作用）。 */
(function () {
  function makeMemoryStore() {
    var _m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(_m, k) ? _m[k] : null; },
      setItem: function (k, v) { _m[k] = String(v); },
      removeItem: function (k) { delete _m[k]; },
      clear: function () { _m = {}; },
      key: function (i) { var ks = Object.keys(_m); return i >= 0 && i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(_m).length; }
    };
  }
  function safeDefine(name) {
    var native;
    try { native = window[name]; } catch (e) { native = null; }
    if (native) return;
    var store = makeMemoryStore();
    try { Object.defineProperty(window, name, { value: store, configurable: true, writable: false }); } catch (e2) {}
  }
  safeDefine('localStorage');
  safeDefine('sessionStorage');
})();