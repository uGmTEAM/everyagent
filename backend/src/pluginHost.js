// 插件宿主（主线程）：声明式 UI 扩展——插槽、整页替换、自定义页、前端资源、导航与配置表单。
// 约定：插件不在主线程执行任意代码，所有渲染都由平台按 manifest 读取模板完成。
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const plugins = require('./plugins');

const VIEWS_DIR = path.join(__dirname, 'views');
const warned = new Set();

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[plugin] ${message}`);
}

function pageKey(req) {
  const url = String(req?.path || '');
  if (url === '/' || url === '') return 'overview';
  if (url.startsWith('/companion')) return 'companion';
  if (/^\/agents\/[^/]+/.test(url)) return 'agent_detail';
  if (url === '/setup') return 'settings';
  if (url === '/plugins') return 'plugins';
  return url.replace(/^\//, '').split('/')[0] || 'overview';
}

function entries() {
  return plugins.enabledManifests();
}

function slotEntries(name) {
  const out = [];
  for (const entry of entries()) {
    const slots = Array.isArray(entry.manifest.slots) ? entry.manifest.slots : [];
    for (const slot of slots) {
      if (String(slot.name || '') !== name) continue;
      out.push({
        pluginId: entry.id,
        manifest: entry.manifest,
        slot,
        order: Number(entry.manifest.order ?? 100),
        slotOrder: Number(slot.order ?? 100)
      });
    }
  }
  out.sort((a, b) => (a.order - b.order) || (a.slotOrder - b.slotOrder));
  return out;
}

function applyOrderWarning(list, kind) {
  for (let index = 1; index < list.length; index += 1) {
    if (list[index].order === list[index - 1].order) {
      warnOnce(
        `${kind}:${list[index].order}`,
        `${kind} 顺序冲突（order=${list[index].order}）：${list[index - 1].pluginId} 与 ${list[index].pluginId}，按插件 ID 稳定排序`
      );
    }
  }
}

function templatePath(pluginId, relative) {
  const root = plugins.pluginDir(pluginId);
  const target = path.resolve(root, String(relative || ''));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('模板路径越界');
  }
  if (!fs.existsSync(target)) throw new Error(`模板不存在：${relative}`);
  return target;
}

function renderTemplate(pluginId, relative, data) {
  const file = templatePath(pluginId, relative);
  const text = fs.readFileSync(file, 'utf8');
  return ejs.render(text, data, {
    filename: file,
    views: [path.dirname(file), VIEWS_DIR],
    cache: false
  });
}

function baseData(pluginId, manifest, extra) {
  const config = plugins.getConfig(pluginId);
  return {
    ...(extra || {}),
    pluginId,
    pluginName: manifest?.name || pluginId,
    plugin: { id: pluginId, name: manifest?.name || pluginId, version: manifest?.version || '', config },
    config
  };
}

function pagesAllow(manifest, currentPage) {
  const pages = Array.isArray(manifest?.pages) ? manifest.pages : [];
  if (!pages.length) return true;
  return pages.includes(currentPage);
}

// 渲染某个插槽；单个插件渲染失败只影响自己
function renderSlot(name, data = {}, req = null) {
  const list = slotEntries(name).filter((item) => pagesAllow(item.manifest, pageKey(req)));
  if (!list.length) return '';
  applyOrderWarning(list, `插槽 ${name}`);
  const parts = [];
  for (const item of list) {
    try {
      const html = renderTemplate(
        item.pluginId,
        item.slot.template,
        baseData(item.pluginId, item.manifest, data)
      );
      parts.push(`<div class="plugin-slot" data-plugin="${item.pluginId}" data-slot="${name}">${html}</div>`);
    } catch (error) {
      console.error(`[plugin] ${item.pluginId} 渲染插槽 ${name} 失败：${error.message}`);
      plugins.recordPluginError(item.pluginId, `渲染插槽 ${name} 失败：${error.message}`);
    }
  }
  return parts.join('\n');
}

function navItems() {
  const out = [];
  for (const entry of entries()) {
    const list = Array.isArray(entry.manifest.nav) ? entry.manifest.nav : [];
    for (const item of list) {
      const href = String(item.href || '');
      if (!href.startsWith(`/plugin/${entry.id}/`)) continue;
      out.push({ href, label: String(item.label || entry.manifest.name || entry.id), order: Number(item.order ?? 100) });
    }
  }
  out.sort((a, b) => a.order - b.order);
  return out;
}

function navHtml() {
  return navItems()
    .map((item) => `<a href="${escapeAttr(item.href)}">${escapeHtml(item.label)}</a>`)
    .join('\n');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/'/g, '&#39;');
}

// 整页替换：GET 精确匹配；若该页存在插槽注入，则告警并放弃替换（插槽优先）
function replacementFor(req) {
  if (req.method !== 'GET') return null;
  const current = pageKey(req);
  const candidates = [];
  for (const entry of entries()) {
    const list = Array.isArray(entry.manifest.replace) ? entry.manifest.replace : [];
    for (const item of list) {
      if (String(item.path || '') !== req.path) continue;
      candidates.push({ pluginId: entry.id, manifest: entry.manifest, item });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(a.manifest.order ?? 100) - Number(b.manifest.order ?? 100));
  applyOrderWarning(candidates, `整页替换 ${req.path}`);

  const hasSlot = entries().some((entry) => {
    const slots = Array.isArray(entry.manifest.slots) ? entry.manifest.slots : [];
    const pages = Array.isArray(entry.manifest.pages) ? entry.manifest.pages : [];
    return slots.length > 0 && pages.includes(current);
  });
  if (hasSlot) {
    warnOnce(`replace-blocked:${req.path}`, `${req.path} 同时存在整页替换与插槽注入，按约定放弃替换、保留插槽`);
    return null;
  }
  return candidates[0];
}

function renderPage(match, req, res) {
  const html = renderTemplate(
    match.pluginId,
    match.item.template,
    baseData(match.pluginId, match.manifest, { ...(res.locals || {}), req })
  );
  const wrapped = `<div class="plugin-page" data-plugin="${match.pluginId}">${html}</div>`;
  return injectAssets(wrapped);
}

// 插件自定义页面：必须挂在 /plugin/<id>/ 下
function routeMiddleware() {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    for (const entry of entries()) {
      const list = Array.isArray(entry.manifest.routes) ? entry.manifest.routes : [];
      for (const item of list) {
        const routePath = String(item.path || '');
        if (routePath !== req.path) continue;
        if (!routePath.startsWith(`/plugin/${entry.id}/`)) continue;
        try {
          const html = renderTemplate(
            entry.id,
            item.template,
            baseData(entry.id, entry.manifest, { ...(res.locals || {}), req })
          );
          res.type('html').send(injectAssets(`<div class="plugin-page" data-plugin="${entry.id}">${html}</div>`));
        } catch (error) {
          next(error);
        }
        return;
      }
    }
    next();
  };
}

function readAsset(pluginId, relative) {
  const file = templatePath(pluginId, relative);
  return fs.readFileSync(file, 'utf8');
}

function assetUrls(pluginId, manifest) {
  const assets = manifest.assets && typeof manifest.assets === 'object' ? manifest.assets : {};
  const css = Array.isArray(assets.css) ? assets.css : [];
  const js = Array.isArray(assets.js) ? assets.js : [];
  return { css, js };
}

// 前端注入：样式默认用 @scope 限定在 [data-plugin] 内；globalStyles=true 时原样注入
function injectAssets(html) {
  const list = entries();
  const styles = [];
  const scripts = [];
  for (const entry of list) {
    const { css, js } = assetUrls(entry.id, entry.manifest);
    for (const file of css) {
      try {
        let text = readAsset(entry.id, file);
        text = text.replace(/<\/style/gi, '<\\/style');
        if (entry.manifest.globalStyles === true) {
          styles.push(`<style data-plugin="${entry.id}" data-asset="${file}">${text}</style>`);
        } else {
          styles.push(`<style data-plugin="${entry.id}" data-asset="${file}">@scope ([data-plugin="${entry.id}"]) {${text}}</style>`);
        }
      } catch (error) {
        console.error(`[plugin] ${entry.id} 注入样式 ${file} 失败：${error.message}`);
      }
    }
    for (const file of js) {
      scripts.push(`<script src="/plugin-assets/${entry.id}/${encodeURI(file)}" data-plugin="${entry.id}" defer></script>`);
    }
  }
  let out = html;
  if (styles.length) {
    const block = `\n${styles.join('\n')}\n`;
    out = out.includes('</head>') ? out.replace('</head>', `${block}</head>`) : `${block}${out}`;
  }
  if (scripts.length) {
    const block = `\n${scripts.join('\n')}\n`;
    out = out.includes('</body>') ? out.replace('</body>', `${block}</body>`) : `${out}${block}`;
  }
  return out;
}

function assetMiddleware() {
  return (req, res, next) => {
    const match = String(req.path || '').match(/^\/plugin-assets\/([a-z0-9][a-z0-9_-]{1,39})\/(.+)$/);
    if (!match) return next();
    const pluginId = match[1];
    const relative = decodeURIComponent(match[2]);
    if (!plugins.describe(pluginId).record) return next();
    try {
      const file = templatePath(pluginId, relative);
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(file);
    } catch (error) {
      res.status(404).type('text').send('资源不存在');
    }
  };
}

// 在每个请求上挂 slot()/导航，并统一在 res.render 之后注入前端资源
function middleware() {
  return (req, res, next) => {
    res.locals.slot = (name, data) => renderSlot(name, { ...res.locals, ...(data || {}) }, req);
    res.locals.pluginNavHtml = navHtml();
    res.locals.pluginNav = navItems();
    const originalRender = res.render.bind(res);
    res.render = (view, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      const opts = typeof options === 'function' ? undefined : options;
      originalRender(view, opts, (error, html) => {
        if (error) {
          if (cb) return cb(error);
          return next(error);
        }
        let out = html;
        try {
          out = injectAssets(out);
        } catch (injectError) {
          console.error(`[plugin] 注入资源失败：${injectError.message}`);
        }
        if (cb) return cb(null, out);
        res.send(out);
      });
    };
    next();
  };
}

module.exports = {
  middleware,
  routeMiddleware,
  assetMiddleware,
  replacementFor,
  renderPage,
  pageKey,
  navHtml,
  navItems,
  renderSlot,
  injectAssets
};
