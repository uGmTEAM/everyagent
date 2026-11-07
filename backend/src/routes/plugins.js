const fs = require('fs');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const plugins = require('../plugins');

const router = express.Router();

const upload = multer({
  dest: config.uploadsDir,
  limits: { fileSize: 200 * 1024 * 1024, files: 1 }
});

function cleanup(file) {
  if (!file?.path) return;
  try {
    fs.unlinkSync(file.path);
  } catch {
    // ignore
  }
}

function back(message, error = null) {
  const query = error ? `error=${encodeURIComponent(error)}` : `message=${encodeURIComponent(message)}`;
  return `/plugins?${query}`;
}

router.get('/plugins', (req, res) => {
  const list = plugins.listPlugins();
  res.render('plugins', {
    title: '插件',
    active: 'plugins',
    list,
    message: req.query.message ? String(req.query.message) : null,
    error: req.query.error ? String(req.query.error) : null
  });
});

router.post('/plugins/install', upload.single('package'), (req, res) => {
  try {
    const gitUrl = String(req.body.git_url || '').trim();
    if (req.file) {
      const result = plugins.installFromZip(req.file.path, { sourceName: req.file.originalname });
      return res.redirect(back(`插件 ${result.id} 已安装，重启后端后生效${result.warnings.length ? `（${result.warnings.join('；')}）` : ''}`));
    }
    if (gitUrl) {
      const result = plugins.installFromGit(gitUrl, String(req.body.git_branch || 'main').trim());
      return res.redirect(back(`插件 ${result.id} 已安装，重启后端后生效${result.warnings.length ? `（${result.warnings.join('；')}）` : ''}`));
    }
    return res.redirect(back('', '请选择压缩包或填写 git 地址'));
  } catch (error) {
    return res.redirect(back('', `安装失败：${error.message}`));
  } finally {
    cleanup(req.file);
  }
});

router.get('/plugins/:id', (req, res) => {
  const detail = plugins.describe(req.params.id);
  if (!detail.record) {
    return res.status(404).render('error', { title: '未找到', message: '插件不存在' });
  }
  res.render('plugin_detail', {
    title: `插件 ${detail.id}`,
    active: 'plugins',
    detail,
    configSchema: Array.isArray(detail.manifest?.config) ? detail.manifest.config : [],
    config: plugins.getConfig(detail.id),
    log: plugins.tailLog(detail.id, 200),
    message: req.query.message ? String(req.query.message) : null,
    error: req.query.error ? String(req.query.error) : null
  });
});

router.post('/plugins/:id/config', (req, res) => {
  try {
    const detail = plugins.describe(req.params.id);
    if (!detail.record) throw new Error('插件不存在');
    const schema = Array.isArray(detail.manifest?.config) ? detail.manifest.config : [];
    const values = {};
    for (const field of schema) {
      const key = String(field.key || '');
      if (!key) continue;
      const raw = req.body[key];
      if (field.type === 'checkbox') values[key] = raw === '1' || raw === 'on' || raw === 'true';
      else if (field.type === 'number') values[key] = Number(raw || 0);
      else values[key] = raw === undefined ? '' : String(raw);
    }
    plugins.setConfig(req.params.id, values);
    return res.redirect(`/plugins/${req.params.id}?message=${encodeURIComponent('配置已保存')}`);
  } catch (error) {
    return res.redirect(back('', `保存配置失败：${error.message}`));
  }
});

router.post('/plugins/:id/enable', (req, res) => {
  try {
    plugins.setEnabled(req.params.id, true);
    return res.redirect(back(`插件 ${req.params.id} 已启用，重启后端后生效`));
  } catch (error) {
    return res.redirect(back('', `启用失败：${error.message}`));
  }
});

router.post('/plugins/:id/disable', (req, res) => {
  try {
    plugins.setEnabled(req.params.id, false);
    return res.redirect(back(`插件 ${req.params.id} 已禁用`));
  } catch (error) {
    return res.redirect(back('', `禁用失败：${error.message}`));
  }
});

router.post('/plugins/:id/update', upload.single('package'), (req, res) => {
  try {
    const result = plugins.updatePlugin(req.params.id, {
      zipPath: req.file?.path,
      branch: String(req.body.git_branch || '').trim() || null
    });
    return res.redirect(back(`插件 ${result.id} 已更新，重启后端后生效`));
  } catch (error) {
    return res.redirect(back('', `更新失败：${error.message}`));
  } finally {
    cleanup(req.file);
  }
});

router.post('/plugins/:id/uninstall', (req, res) => {
  try {
    plugins.uninstall(req.params.id, { deleteData: String(req.body.delete_data || '') === '1' });
    return res.redirect(back(`插件 ${req.params.id} 已卸载`));
  } catch (error) {
    return res.redirect(back('', `卸载失败：${error.message}`));
  }
});

router.post('/plugins/:id/clear-data', (req, res) => {
  try {
    plugins.clearData(req.params.id);
    return res.redirect(back(`插件 ${req.params.id} 的数据已清除`));
  } catch (error) {
    return res.redirect(back('', `清除失败：${error.message}`));
  }
});

// 插件页面 -> 插件方法：只放行 tools.* 与 ui.*，其余内部方法不对外暴露
router.post('/plugin-api/:id/call', async (req, res) => {
  const id = String(req.params.id || '');
  const method = String(req.body?.method || '');
  const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {};
  if (!/^(tools|ui)\.[A-Za-z0-9_-]+$/.test(method)) {
    return res.status(400).json({ ok: false, error: { message: '方法名不合法，只允许 tools.* 或 ui.*' } });
  }
  const detail = plugins.describe(id);
  if (!detail.record) {
    return res.status(404).json({ ok: false, error: { message: '插件不存在' } });
  }
  if (!detail.enabled) {
    return res.status(400).json({ ok: false, error: { message: '插件未启用' } });
  }
  try {
    let value;
    if (method.startsWith('tools.')) {
      value = await plugins.callTool(id, method.slice('tools.'.length), args);
    } else {
      const detailManifest = detail.manifest || {};
      const timeout = Math.min(Math.max(Number(detailManifest.ui_timeout_ms) || 30000, 1000), 120000);
      value = await plugins.callPlugin(id, method, args, timeout);
    }
    return res.json({ ok: true, value });
  } catch (error) {
    const running = detail.status === 'running';
    return res.status(running ? 500 : 409).json({
      ok: false,
      error: { message: running ? error.message : `插件未运行（状态：${detail.status}），请先启用并重启后端` }
    });
  }
});

// 插件日志：与平台日志页同一套视图，按文件增量推送
router.get('/logs/plugin/stream', (req, res) => {
  const id = String(req.query.plugin || '');
  const detail = plugins.describe(id);
  if (!detail.record) {
    return res.status(404).json({ error: { message: '插件不存在' } });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const file = plugins.logFile(id);
  const send = (line) => res.write(`data: ${JSON.stringify({ line, stream: 'file', plugin: id })}\n\n`);
  for (const line of plugins.tailLog(id, 300)) send(line);

  let position = 0;
  try {
    position = fs.statSync(file).size;
  } catch {
    position = 0;
  }
  let buffer = '';
  let closed = false;

  const readNew = () => {
    if (closed) return;
    try {
      const stat = fs.statSync(file);
      if (stat.size < position) position = 0; // 日志轮转后从头读
      if (stat.size === position) return;
      const length = stat.size - position;
      const fd = fs.openSync(file, 'r');
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, position);
      fs.closeSync(fd);
      position = stat.size;
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) if (line) send(line);
    } catch {
      // 文件尚未创建时跳过
    }
  };

  const timer = setInterval(readNew, 1000);
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      // ignore
    }
  }, 20000);
  req.on('close', () => {
    closed = true;
    clearInterval(timer);
    clearInterval(keepAlive);
  });
});

module.exports = router;
