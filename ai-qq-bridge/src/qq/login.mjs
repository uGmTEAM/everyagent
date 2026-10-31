import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { sleep } from '../util.mjs';

/**
 * 扫码登录 / 快速登录 / 掉线状态管理。
 * 不依赖 WebUI：二维码通过 HTTP API 暴露，扫码成功后自动删除本地二维码文件。
 */
export class LoginManager extends EventEmitter {
  constructor ({ loginService, logger, config }) {
    super();
    this.loginService = loginService;
    this.logger = logger;
    this.config = config;
    this.dataDir = config._dataDir;
    this.qrcodePath = path.join(this.dataDir, 'qrcode.png');
    this.state = {
      phase: 'starting',
      online: false,
      uin: '',
      uid: '',
      error: '',
      qr_url: '',
      qr_base64: '',
      qr_updated_at: 0,
      login_list: [],
      last_change: Date.now()
    };
    this._started = false;
    this._onlineWaiter = null;
    this._onlineTimer = null;
    this._qrTimer = null;
    this._listener = null;
    this._quickTried = false;
  }

  _set (patch) {
    Object.assign(this.state, patch, { last_change: Date.now() });
  }

  publicState () {
    return {
      phase: this.state.phase,
      online: this.state.online,
      uin: this.state.uin,
      uid: this.state.uid,
      error: this.state.error,
      qr_url: this.state.qr_url,
      qr_base64: this.state.qr_base64,
      qr_updated_at: this.state.qr_updated_at,
      login_list: this.state.login_list,
      last_change: this.state.last_change
    };
  }

  async _refreshLoginList () {
    try {
      const res = await this.loginService.getLoginList();
      const list = (res?.LocalLoginInfoList || []).map(item => ({
        uin: String(item.uin || ''),
        uid: String(item.uid || ''),
        nick: String(item.nickName || ''),
        quick: !!item.isQuickLogin
      }));
      this._set({ login_list: list });
    } catch (error) {
      this.logger?.debug('[login] 获取历史登录列表失败', error);
    }
  }

  async _waitNetwork (timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let status = 0;
      try {
        status = this.loginService.getMsfStatus();
      } catch {
        status = 0;
      }
      if (status !== 3) return true;
      await sleep(500);
    }
    return false;
  }

  async start ({ account = '' } = {}) {
    if (this._started) return;
    this._started = true;
    this._set({ phase: 'starting' });

    const listener = {
      onLoginConnected: () => {
        this.logger?.info('[login] 登录服务已连接');
        this._waitNetwork().then(ok => {
          if (ok) this._beginLogin(account);
        }).catch(error => this.logger?.error('[login] 等待网络异常', error));
      },
      onLoginConnecting: () => this.logger?.debug('[login] 登录服务连接中'),
      onLoginDisConnected: () => this._markOffline('disconnected'),
      onLogoutSucceed: () => this._markOffline('logout'),
      onLogoutFailed: () => this.logger?.warn('[login] 退出登录失败'),
      onUserLoggedIn: (userid) => {
        this._set({ phase: 'offline', online: false, error: `账号 ${userid} 已在其他客户端登录，无法重复登录` });
        this.logger?.error(`[login] 账号 ${userid} 已在其他客户端登录`);
      },
      onQRCodeGetPicture: ({ pngBase64QrcodeData, qrcodeUrl } = {}) => {
        try {
          const raw = String(pngBase64QrcodeData || '').replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(raw, 'base64');
          fs.mkdirSync(path.dirname(this.qrcodePath), { recursive: true });
          fs.writeFileSync(this.qrcodePath, buffer);
          this._set({
            phase: 'waiting_qrcode',
            online: false,
            error: '',
            qr_url: String(qrcodeUrl || ''),
            qr_base64: raw,
            qr_updated_at: Date.now()
          });
          this.logger?.info('[login] 二维码已生成，请调用 GET /v1/login/qrcode 获取');
          this._armQrExpiry();
        } catch (error) {
          this.logger?.error('[login] 解析二维码失败', error);
        }
      },
      onQRCodeSessionUserScaned: () => {
        this._set({ phase: 'scanned' });
        this.logger?.info('[login] 二维码已被扫描，等待手机确认');
      },
      onQRCodeSessionFailed: (errType, errCode) => {
        this.logger?.warn(`[login] 二维码会话失败 errType=${errType} errCode=${errCode}`);
        if (errType === 1 && errCode === 3 && !this.state.online) {
          this._set({ phase: 'waiting_qrcode', error: '二维码已过期，正在刷新' });
          this.requestQR();
        }
      },
      onQRCodeLoginSucceed: (result = {}) => {
        this._handleOnline({ uin: String(result.uin || ''), uid: String(result.uid || '') });
      },
      onLoginFailed: (...args) => {
        const info = JSON.stringify(args);
        this._set({ phase: 'offline', online: false, error: `登录失败: ${info}` });
        this.logger?.error('[login] 登录失败', info);
        this.emit('login_failed', info);
      },
      onQQLoginNumLimited: (...args) => {
        this._set({ error: '登录次数受限: ' + JSON.stringify(args) });
      }
    };

    this._listener = listener;
    this.loginService.addKernelLoginListener(listener);
    this.loginService.connect();
    this._refreshLoginList().catch(error => this.logger?.debug('[login] 获取历史登录列表失败', error));
    this.logger?.info('[login] 已启动登录服务');
    return this.state;
  }

  _armQrExpiry () {
    if (this._qrTimer) clearTimeout(this._qrTimer);
    const seconds = Number(this.config.qq.qrTimeoutSec || 180);
    this._qrTimer = setTimeout(() => {
      if (!this.state.online && this.state.phase === 'waiting_qrcode') {
        this._set({ error: '二维码已过期，正在刷新' });
        this.requestQR();
      }
    }, seconds * 1000);
  }

  async _beginLogin (account) {
    if (this.state.online) return;
    const target = String(account || this.config.qq.account || '').trim();
    if (target && !this._quickTried) {
      this._quickTried = true;
      const ok = await this.quickLogin(target);
      if (ok) return;
    }
    this.requestQR();
  }

  async quickLogin (uin) {
    try {
      this._set({ phase: 'initializing', error: '' });
      const res = await this.loginService.quickLoginWithUin(String(uin));
      if (res?.result === '0' && !res?.loginErrorInfo?.errMsg) {
        this.logger?.info(`[login] 快速登录成功 uin=${uin}`);
        await sleep(1500);
        if (!this.state.online) {
          await this._refreshLoginList();
          const entry = this.state.login_list.find(item => item.uin === String(uin));
          if (entry) this._handleOnline({ uin: entry.uin, uid: entry.uid });
        }
        return true;
      }
      const message = res?.loginErrorInfo?.errMsg || `result=${res?.result}`;
      this.logger?.warn(`[login] 快速登录失败：${message}`);
      this._set({ error: `快速登录失败：${message}` });
      return false;
    } catch (error) {
      this.logger?.error('[login] 快速登录异常', error);
      this._set({ error: `快速登录异常：${error.message}` });
      return false;
    }
  }

  requestQR () {
    try {
      const accepted = this.loginService.getQRCodePicture();
      if (!accepted) this.logger?.warn('[login] QQ 未接受二维码刷新请求');
      return !!accepted;
    } catch (error) {
      this.logger?.error('[login] 获取二维码失败', error);
      this._set({ error: `获取二维码失败：${error.message}` });
      return false;
    }
  }

  _handleOnline ({ uin, uid }) {
    if (!uin) return;
    this._set({
      phase: 'online',
      online: true,
      uin,
      uid,
      error: '',
      qr_url: '',
      qr_base64: '',
      qr_updated_at: 0
    });
    if (this._qrTimer) clearTimeout(this._qrTimer);
    try {
      if (fs.existsSync(this.qrcodePath)) fs.unlinkSync(this.qrcodePath);
    } catch {
      // ignore
    }
    this.logger?.info(`[login] 登录成功 uin=${uin}`);
    if (this._onlineWaiter) {
      clearTimeout(this._onlineTimer);
      const resolve = this._onlineWaiter;
      this._onlineWaiter = null;
      resolve({ uin, uid });
    }
    this.emit('online', { uin, uid });
  }

  _markOffline (reason) {
    if (!this.state.online && this.state.phase === 'offline') return;
    const label = {
      disconnected: '登录服务已断开',
      logout: '已退出登录',
      kicked: '账号被踢下线',
      silent_offline: '静默离线'
    }[reason] || reason;
    this._set({ phase: 'offline', online: false, error: label, qr_base64: '', qr_url: '' });
    this._quickTried = false;
    this.logger?.warn(`[login] 已离线：${label}`);
    this.emit('offline', reason);
  }

  markOffline (reason) {
    this._markOffline(reason);
  }

  setOfflineSilently (reason) {
    const label = {
      disconnected: '登录服务已断开',
      logout: '已退出登录',
      kicked: '账号被踢下线',
      silent_offline: '静默离线'
    }[reason] || reason;
    this._set({ phase: 'offline', online: false, error: label, qr_base64: '', qr_url: '' });
  }

  waitForOnline (timeoutMs = 30000) {
    if (this.state.online) return Promise.resolve({ uin: this.state.uin, uid: this.state.uid });
    return new Promise((resolve, reject) => {
      this._onlineWaiter = resolve;
      this._onlineTimer = setTimeout(() => {
        if (this._onlineWaiter === resolve) this._onlineWaiter = null;
        reject(new Error('等待登录超时'));
      }, timeoutMs);
    });
  }

  stop () {
    if (this._qrTimer) clearTimeout(this._qrTimer);
    if (this._onlineTimer) clearTimeout(this._onlineTimer);
  }
}
