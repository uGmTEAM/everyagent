/**
 * QQ NT 内核调用封装：
 * - 服务方法调用后，结果通常由 Listener 异步回调返回
 * - 这里把「调用 + 监听 + 超时」封装成 Promise
 * - 同时支持纯事件订阅（收消息、被踢下线等）
 */
export class EventBus {
  constructor ({ session, logger, defaultTimeout = 15000 }) {
    this.session = session;
    this.logger = logger;
    this.defaultTimeout = defaultTimeout;
    this.dispatchers = new Map();
    this.tasks = new Map();
    this.subscribers = new Map();
  }

  _service (listenerMainName) {
    const short = listenerMainName.replace(/^NodeIKernel/, '').replace(/Listener$/, '');
    const getter = `get${short}Service`;
    const service = this.session?.[getter]?.();
    if (!service) throw new Error(`内核服务不存在：${getter}`);
    return service;
  }

  _ensureDispatcher (listenerMainName) {
    if (this.dispatchers.has(listenerMainName)) return;
    const short = listenerMainName.replace(/^NodeIKernel/, '').replace(/Listener$/, '');
    const service = this._service(listenerMainName);
    const registrar = `addKernel${short}Listener`;
    if (typeof service[registrar] !== 'function') {
      throw new Error(`内核监听器注册方法不存在：${registrar}`);
    }
    const dispatcher = new Proxy({}, {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        return (...args) => this._dispatch(listenerMainName, String(prop), args);
      }
    });
    service[registrar](dispatcher);
    this.dispatchers.set(listenerMainName, dispatcher);
    this.logger?.debug(`[bus] 已注册监听器 ${listenerMainName}`);
  }

  _dispatch (listenerMainName, method, args) {
    const key = `${listenerMainName}/${method}`;
    const list = this.tasks.get(key);
    if (list) {
      const remain = [];
      for (const task of list) {
        let matched = false;
        try {
          matched = task.dataCheck ? task.dataCheck(...args) : true;
        } catch (error) {
          this.logger?.warn(`[bus] 回调判定异常 ${key}`, error);
        }
        if (matched) {
          clearTimeout(task.timer);
          task.resolve([task.immediate, ...args]);
        } else {
          remain.push(task);
        }
      }
      this.tasks.set(key, remain);
    }
    const subs = this.subscribers.get(key);
    if (subs) {
      for (const fn of subs) {
        try {
          fn(...args);
        } catch (error) {
          this.logger?.error(`[bus] 事件订阅回调异常 ${key}`, error);
        }
      }
    }
  }

  on (listenerAndMethod, fn) {
    this._ensureDispatcher(listenerAndMethod.split('/')[0]);
    const list = this.subscribers.get(listenerAndMethod) || [];
    list.push(fn);
    this.subscribers.set(listenerAndMethod, list);
    return () => {
      const arr = this.subscribers.get(listenerAndMethod) || [];
      this.subscribers.set(listenerAndMethod, arr.filter(item => item !== fn));
    };
  }

  async call (serviceAndMethod, listenerAndMethod, args, options = {}) {
    const { dataCheck, timeout = this.defaultTimeout } = options;
    const [listenerMain] = listenerAndMethod.split('/');
    this._ensureDispatcher(listenerMain);

    return new Promise((resolve, reject) => {
      const key = listenerAndMethod;
      const task = {
        dataCheck,
        immediate: undefined,
        resolve,
        timer: setTimeout(() => {
          const list = this.tasks.get(key) || [];
          this.tasks.set(key, list.filter(item => item !== task));
          reject(new Error(`等待内核回调超时：${listenerAndMethod}`));
        }, timeout)
      };
      const list = this.tasks.get(key) || [];
      list.push(task);
      this.tasks.set(key, list);

      try {
        const [serviceName, methodName] = serviceAndMethod.split('/');
        const service = this.session?.[`get${serviceName.replace(/^NodeIKernel/, '').replace(/Service$/, '')}Service`]?.();
        const fn = service?.[methodName];
        if (typeof fn !== 'function') throw new Error(`内核方法不存在：${serviceAndMethod}`);
        const result = fn.apply(service, args);
        if (result && typeof result.then === 'function') {
          result.then(value => { task.immediate = value; }).catch(error => {
            clearTimeout(task.timer);
            const arr = this.tasks.get(key) || [];
            this.tasks.set(key, arr.filter(item => item !== task));
            reject(error);
          });
        } else {
          task.immediate = result;
        }
      } catch (error) {
        clearTimeout(task.timer);
        const arr = this.tasks.get(key) || [];
        this.tasks.set(key, arr.filter(item => item !== task));
        reject(error);
      }
    });
  }

  callDirect (serviceAndMethod, ...args) {
    const [serviceName, methodName] = serviceAndMethod.split('/');
    const getter = `get${serviceName.replace(/^NodeIKernel/, '').replace(/Service$/, '')}Service`;
    const service = this.session?.[getter]?.();
    if (!service) throw new Error(`内核服务不存在：${getter}`);
    const fn = service[methodName];
    if (typeof fn !== 'function') throw new Error(`内核方法不存在：${serviceAndMethod}`);
    return fn.apply(service, args);
  }

  closeAll () {
    for (const list of this.tasks.values()) {
      for (const task of list) clearTimeout(task.timer);
    }
    this.tasks.clear();
    this.subscribers.clear();
  }
}
