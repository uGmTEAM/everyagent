export class NodeIGlobalAdapter {
  onLog () {}
  onGetSrvCalTime () {}
  onShowErrUITips () {}
  fixPicImgType () {}
  getAppSetting () {}
  onInstallFinished () {}
  onUpdateGeneralFlag () {}
  onGetOfflineMsg () {}
}

export class NodeIDependsAdapter {
  onMSFStatusChange () {}
  onMSFSsoError () {}
  getGroupCode () {}
}

export class NodeIDispatcherAdapter {
  dispatchRequest () {}
  dispatchCall () {}
  dispatchCallWithJson () {}
}

export function createSessionListener (onReady) {
  return {
    onNTSessionCreate () {},
    onGProSessionCreate () {},
    onSessionInitComplete () {},
    onOpentelemetryInit (info) {
      if (info?.is_init) onReady?.(null);
      else onReady?.(new Error('opentelemetry init failed'));
    },
    onUserOnlineResult () {},
    onGetSelfTinyId () {}
  };
}
