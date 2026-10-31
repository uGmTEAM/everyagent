(function () {
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text == null ? '' : String(text);
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve();
        else reject(new Error('copy failed'));
      } catch (error) {
        reject(error);
      }
    });
  }

  function flashButton(button, text) {
    if (!button) return;
    var original = button.getAttribute('data-label') || button.textContent;
    button.setAttribute('data-label', original);
    button.textContent = text;
    button.disabled = true;
    setTimeout(function () {
      button.textContent = original;
      button.disabled = false;
    }, 1500);
  }

  // 长文本：自动加「复制」按钮，超过折叠高度时提供「展开 / 收起」。
  function setupTextBlocks() {
    document.querySelectorAll('pre[data-collapse]').forEach(function (pre) {
      if (pre.closest('.text-block')) return;

      var wrap = document.createElement('div');
      wrap.className = 'text-block';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      var tools = document.createElement('div');
      tools.className = 'text-tools';

      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'light tiny';
      copyBtn.textContent = '复制';
      tools.appendChild(copyBtn);

      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'light tiny';
      toggleBtn.textContent = '展开';
      toggleBtn.style.display = 'none';
      tools.appendChild(toggleBtn);

      wrap.insertBefore(tools, pre);

      function refresh() {
        var clipped = pre.scrollHeight > pre.clientHeight + 4;
        var expanded = wrap.classList.contains('expanded');
        wrap.classList.toggle('clipped', clipped);
        toggleBtn.style.display = clipped || expanded ? '' : 'none';
      }

      copyBtn.addEventListener('click', function () {
        copyText(pre.textContent).then(function () {
          flashButton(copyBtn, '已复制');
        }).catch(function () {
          flashButton(copyBtn, '复制失败');
        });
      });

      toggleBtn.addEventListener('click', function () {
        var expanded = wrap.classList.toggle('expanded');
        toggleBtn.textContent = expanded ? '收起' : '展开';
        if (!expanded) pre.scrollTop = 0;
        refresh();
      });

      var details = pre.closest('details');
      if (details) {
        details.addEventListener('toggle', function () {
          if (details.open) refresh();
        });
      }
      refresh();
    });
  }

  function setupTerminalCopy() {
    var button = document.getElementById('terminal-copy');
    var el = document.getElementById('terminal');
    if (!button || !el) return;
    button.addEventListener('click', function () {
      copyText(el.textContent).then(function () {
        flashButton(button, '已复制');
      }).catch(function () {
        flashButton(button, '复制失败');
      });
    });
  }

  function setupProviderSelects() {
    document.querySelectorAll('[data-provider-select]').forEach(function (select) {
      var targetSelector = select.getAttribute('data-model-target');
      var target = targetSelector ? document.querySelector(targetSelector) : null;
      if (!target) return;
      var kind = select.getAttribute('data-model-kind') || 'text';

      function parseList(raw) {
        try {
          return JSON.parse(raw ? decodeURIComponent(raw) : '[]');
        } catch (e) {
          return [];
        }
      }

      function collect(option) {
        var text = parseList(option ? option.getAttribute('data-models') : '');
        var vision = parseList(option ? option.getAttribute('data-vision-models') : '');
        var multi = parseList(option ? option.getAttribute('data-multimodal-models') : '');
        var map = {};
        var order = [];

        function add(name, type) {
          if (!name) return;
          if (map[name]) {
            if (type === 'multimodal') map[name] = 'multimodal';
            return;
          }
          map[name] = type;
          order.push(name);
        }

        if (kind === 'vision') {
          vision.forEach(function (name) { add(name, 'vision'); });
          multi.forEach(function (name) { add(name, 'multimodal'); });
        } else if (kind === 'main') {
          text.forEach(function (name) { add(name, 'text'); });
          multi.forEach(function (name) { add(name, 'multimodal'); });
        } else {
          text.forEach(function (name) { add(name, 'text'); });
        }

        return order.map(function (name) {
          return { name: name, type: map[name] };
        });
      }

      function refresh() {
        var option = select.options[select.selectedIndex];
        var models = collect(option);
        var selected = target.getAttribute('data-selected-model') || target.value;
        target.innerHTML = '';
        models.forEach(function (item) {
          var opt = document.createElement('option');
          opt.value = item.name;
          opt.textContent = item.name +
            (item.type === 'multimodal' ? '（多模态）' : item.type === 'vision' ? '（识图）' : '');
          opt.setAttribute('data-model-type', item.type);
          target.appendChild(opt);
        });
        if (selected && models.some(function (item) { return item.name === selected; })) {
          target.value = selected;
        }
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }

      select.addEventListener('change', refresh);
      refresh();
    });
  }

  function setupTerminal() {
    var el = document.getElementById('terminal');
    if (!el) return;
    var agent = el.getAttribute('data-agent');
    if (!agent || !window.EventSource) return;
    el.textContent = '';
    var source = new EventSource('/agents/' + encodeURIComponent(agent) + '/stream');
    source.onmessage = function (event) {
      var data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      var nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
      el.textContent += (data.line || '') + '\n';
      var lines = el.textContent.split('\n');
      if (lines.length > 3000) {
        el.textContent = lines.slice(lines.length - 3000).join('\n');
      }
      if (nearBottom) el.scrollTop = el.scrollHeight;
    };
    source.onerror = function () {
      el.textContent += '[日志流断开，浏览器会自动重连]\n';
    };
  }

  function setupConfirms() {
    document.querySelectorAll('form[data-confirm]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        if (!window.confirm(form.getAttribute('data-confirm'))) {
          event.preventDefault();
        }
      });
    });
  }

  function setupLogPage() {
    var view = document.getElementById('log-view');
    if (!view) return;

    var mode = view.getAttribute('data-mode') || 'server';
    var agent = view.getAttribute('data-agent') || 'all';
    var levelSelect = document.getElementById('log-level');
    var keywordInput = document.getElementById('log-keyword');
    var pauseButton = document.getElementById('log-pause');
    var copyButton = document.getElementById('log-copy');
    var clearButton = document.getElementById('log-clear');
    var agentSelect = document.getElementById('log-agent');

    var MAX_LINES = 5000;
    var lines = [];
    var paused = false;
    var source = null;
    var openedOnce = false;

    function classify(line, stream) {
      if (stream === 'stderr') return 'error';
      var text = String(line || '');
      if (/\[(error|fatal|crash|death_error|restart_error|judge_error)\]/i.test(text)) return 'error';
      if (/error|exception|失败|异常|错误|crash/i.test(text)) return 'error';
      if (/\[warning\]|警告|warn|disk_warning/i.test(text)) return 'warn';
      return 'info';
    }

    function levelAllowed(level, filter) {
      if (filter === 'info') return true;
      if (filter === 'warn') return level === 'warn' || level === 'error';
      return level === 'error';
    }

    function render() {
      var filter = levelSelect ? levelSelect.value : 'info';
      var keyword = keywordInput ? keywordInput.value.trim().toLowerCase() : '';
      var output = [];

      for (var i = 0; i < lines.length; i += 1) {
        var item = lines[i];
        var level = classify(item.line, item.stream);
        if (!levelAllowed(level, filter)) continue;
        if (keyword && String(item.line || '').toLowerCase().indexOf(keyword) < 0) continue;

        if (mode === 'ai' && agent === 'all' && item.agent) {
          output.push('[' + item.agent + '] ' + item.line);
        } else {
          output.push(item.line);
        }
      }

      if (output.length) {
        view.textContent = output.join('\n');
      } else if (lines.length) {
        view.textContent = '当前筛选条件下没有日志。';
      } else {
        view.textContent = '暂无日志。';
      }
      if (!paused) view.scrollTop = view.scrollHeight;
    }

    function append(item) {
      if (!item || !item.line) return;
      lines.push(item);
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
      if (!paused) render();
    }

    function connect() {
      if (source) source.close();
      var url = mode === 'ai'
        ? '/logs/ai/stream?agent=' + encodeURIComponent(agent)
        : '/logs/server/stream';
      source = new EventSource(url);
      source.onopen = function () {
        if (openedOnce) {
          lines = [];
          render();
        }
        openedOnce = true;
      };
      source.onmessage = function (event) {
        try {
          append(JSON.parse(event.data));
        } catch (e) {
          // ignore malformed events
        }
      };
    }

    if (levelSelect) levelSelect.addEventListener('change', render);
    if (keywordInput) keywordInput.addEventListener('input', render);
    if (pauseButton) {
      pauseButton.addEventListener('click', function () {
        paused = !paused;
        pauseButton.textContent = paused ? '继续滚动' : '暂停滚动';
        if (!paused) render();
      });
    }
    if (copyButton) {
      copyButton.addEventListener('click', function () {
        copyText(view.textContent).then(function () {
          flashButton(copyButton, '已复制');
        }).catch(function () {
          flashButton(copyButton, '复制失败');
        });
      });
    }
    if (clearButton) {
      clearButton.addEventListener('click', function () {
        lines = [];
        view.textContent = '暂无日志。';
      });
    }
    if (agentSelect) {
      agentSelect.addEventListener('change', function () {
        window.location.href = '/logs?tab=ai&agent=' + encodeURIComponent(agentSelect.value);
      });
    }

    render();
    connect();
  }

  function setupUnlimitedToggle() {
    var checkbox = document.getElementById('unlimited-tokens');
    var input = document.getElementById('initial-balance');
    if (!checkbox || !input) return;

    function refresh() {
      input.disabled = checkbox.checked;
      if (checkbox.checked) {
        input.setAttribute('data-previous', input.value || '');
        input.value = '';
        input.placeholder = '无限额度';
      } else {
        if (!input.value) {
          input.value = input.getAttribute('data-previous') || '10000000';
        }
        input.placeholder = '';
      }
    }

    checkbox.addEventListener('change', refresh);
    refresh();
  }

  function setupAgentVisionForm() {
    var modeSelect = document.getElementById('vision-mode');
    var privateFields = document.getElementById('private-vision-fields');
    var mainOption = document.getElementById('main-vision-option');
    var modelSelect = document.getElementById('model-select');
    if (!modeSelect) return;

    function selectedModelType() {
      if (!modelSelect) return 'text';
      var option = modelSelect.options[modelSelect.selectedIndex];
      return option ? (option.getAttribute('data-model-type') || 'text') : 'text';
    }

    function refreshMainOption() {
      if (!mainOption) return;
      var multimodal = selectedModelType() === 'multimodal';
      mainOption.disabled = !multimodal;
      if (!multimodal && modeSelect.value === 'main') {
        // 陪伴模式禁用「不启用」，主模型不是多模态时退回共用识图。
        var noneOption = modeSelect.querySelector('option[value="none"]');
        modeSelect.value = (noneOption && noneOption.disabled) ? 'shared' : 'none';
      }
    }

    function refreshPrivateFields() {
      if (!privateFields) return;
      privateFields.style.display = modeSelect.value === 'private' ? '' : 'none';
    }

    if (modelSelect) {
      modelSelect.addEventListener('change', function () {
        refreshMainOption();
        refreshPrivateFields();
      });
    }
    modeSelect.addEventListener('change', refreshPrivateFields);

    refreshMainOption();
    refreshPrivateFields();
  }

  function setupTableScroll() {
    document.querySelectorAll('main table').forEach(function (table) {
      if (table.parentElement && table.parentElement.classList.contains('table-wrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    setupProviderSelects();
    setupTerminal();
    setupTerminalCopy();
    setupConfirms();
    setupLogPage();
    setupUnlimitedToggle();
    setupAgentVisionForm();
    setupTableScroll();
    setupTextBlocks();
  });
})();
