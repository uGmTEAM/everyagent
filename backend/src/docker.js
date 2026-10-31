const Docker = require('dockerode');
const fs = require('fs');
const config = require('./config');
const db = require('./db');

let docker = null;

function client() {
  if (!docker) {
    docker = new Docker({ socketPath: config.dockerSocket });
  }
  return docker;
}

async function isAvailable() {
  try {
    // Docker 引擎卡死时 ping 会一直挂起；限时失败，避免整个总览页面被阻塞。
    await Promise.race([
      client().ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('docker ping timeout')), 5000))
    ]);
    return true;
  } catch {
    return false;
  }
}

async function imageExists(image) {
  try {
    await client().getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

async function ensureControlNetwork() {
  const api = client();
  const networks = await api.listNetworks({ filters: { name: [config.controlNetwork] } });
  if (networks.some((n) => n.Name === config.controlNetwork)) return;
  try {
    await api.createNetwork({
      Name: config.controlNetwork,
      Driver: 'bridge',
      CheckDuplicate: true,
      Labels: { 'ea.role': 'control' }
    });
  } catch (error) {
    if (!String(error.message).includes('already exists')) throw error;
  }
}

async function inspectContainerByName(name) {
  try {
    return await client().getContainer(name).inspect();
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

function normalizePorts(ports) {
  return Object.keys(ports || {})
    .sort()
    .map((key) => `${key}=${JSON.stringify(ports[key])}`)
    .join(';');
}

async function screenForwardConfig() {
  const rows = db.all(
    "SELECT seq FROM agents WHERE enable_screen = 1 AND status NOT IN ('dead', 'finalizing') ORDER BY seq"
  );
  const forwards = rows.map(
    (row) => `${config.noVncBasePort + row.seq}=ea-ai-${String(row.seq).padStart(3, '0')}:6080`
  );
  const ports = {};
  for (const row of rows) {
    const port = config.noVncBasePort + row.seq;
    ports[`${port}/tcp`] = [{ HostIp: '127.0.0.1', HostPort: String(port) }];
  }
  return { forwards: forwards.join(','), ports };
}

async function connectEgressToAgentNetworks(egressId) {
  const api = client();
  const networks = await api.listNetworks({ filters: { label: ['ea.role=agent'] } });
  for (const network of networks) {
    try {
      await api.getNetwork(network.Id).connect({
        Container: egressId,
        EndpointConfig: { Aliases: ['egress'] }
      });
    } catch (error) {
      const message = String(error.message || '');
      if (!message.includes('already exists') && !message.includes('already connected')) {
        continue;
      }
    }
  }
}

async function ensureEgress() {
  await ensureControlNetwork();
  if (!(await imageExists(config.egressImage))) {
    throw new Error(`出网代理镜像 ${config.egressImage} 不存在，请先运行 tools/build-images.ps1`);
  }

  const screen = await screenForwardConfig();
  let info = await inspectContainerByName(config.egressContainer);
  if (info) {
    const currentForwards =
      (info.Config?.Env || [])
        .find((item) => item.startsWith('TCP_FORWARDS='))
        ?.slice('TCP_FORWARDS='.length) || '';
    const currentPorts = info.HostConfig?.PortBindings || {};
    if (currentForwards !== screen.forwards || normalizePorts(currentPorts) !== normalizePorts(screen.ports)) {
      await client().getContainer(info.Id).remove({ force: true }).catch(() => {});
      info = null;
    }
  }

  if (!info) {
    const container = await client().createContainer({
      name: config.egressContainer,
      Image: config.egressImage,
      Env: [
        `UPSTREAM=http://host.docker.internal:${config.backendPort}`,
        'PORT=7842',
        `TCP_FORWARDS=${screen.forwards}`
      ],
      ExposedPorts: { '7842/tcp': {}, ...Object.fromEntries(Object.keys(screen.ports).map((key) => [key, {}])) },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        PortBindings: screen.ports,
        ExtraHosts: ['host.docker.internal:host-gateway'],
        LogConfig: {
          Type: 'json-file',
          Config: { 'max-size': '20m', 'max-file': '2' }
        }
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [config.controlNetwork]: { Aliases: ['egress-control'] }
        }
      }
    });
    await container.start();
    info = await container.inspect();
  } else if (!info.State?.Running) {
    await client().getContainer(info.Id).start();
    info = await inspectContainerByName(config.egressContainer);
  }

  await connectEgressToAgentNetworks(info.Id);
  return info;
}

async function ensureAgentNetwork(seq) {
  const api = client();
  const name = `ea-ai-${String(seq).padStart(3, '0')}`;
  const egress = await ensureEgress();

  let network = null;
  try {
    network = await api.getNetwork(name).inspect();
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }

  if (!network) {
    await api.createNetwork({
      Name: name,
      Driver: 'bridge',
      Internal: true,
      CheckDuplicate: true,
      Labels: { 'ea.role': 'agent', 'ea.agent-seq': String(seq) }
    });
    network = await api.getNetwork(name).inspect();
  }

  const connected = network.Containers && Object.values(network.Containers).some(
    (item) => item.Name === config.egressContainer
  );
  if (!connected) {
    try {
      await api.getNetwork(name).connect({
        Container: egress.Id,
        EndpointConfig: { Aliases: ['egress'] }
      });
    } catch (error) {
      const message = String(error.message || '');
      if (!message.includes('already exists') && !message.includes('already connected')) {
        throw error;
      }
    }
  }

  return name;
}

async function ensureOutboundNetwork(seq) {
  const api = client();
  const name = `${config.outboundNetworkPrefix}-${String(seq).padStart(3, '0')}`;
  try {
    await api.getNetwork(name).inspect();
    return name;
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }

  await api.createNetwork({
    Name: name,
    Driver: 'bridge',
    CheckDuplicate: true,
    Labels: { 'ea.role': 'agent-outbound', 'ea.agent-seq': String(seq) }
  });
  return name;
}

function toDockerPath(value) {
  return String(value).replace(/\\/g, '/');
}

async function createAgentContainer(agent, { hostWorkspace, hostRulesFile = null, toolkitBinds = [] }) {
  const api = client();
  const isCompanion = agent.mode === 'companion';
  const internalNetwork = await ensureAgentNetwork(agent.seq);
  // 陪伴 AI 需要直连 QQ 服务器：无论是否勾选外网，都额外接入出网网络。
  const outboundNetwork = agent.allow_internet || isCompanion
    ? await ensureOutboundNetwork(agent.seq)
    : null;
  const primaryNetwork = outboundNetwork || internalNetwork;
  const name = `ea-ai-${String(agent.seq).padStart(3, '0')}`;

  const existing = await inspectContainerByName(name);
  if (existing) {
    if (existing.State?.Running) {
      await api.getContainer(existing.Id).stop({ t: 10 }).catch(() => {});
    }
    await api.getContainer(existing.Id).remove({ force: true }).catch(() => {});
  }

  const screenEnabled = isCompanion ? true : Boolean(agent.enable_screen);
  const bridgePort = config.bridgeBasePort + agent.seq;
  const bridgePorts = isCompanion
    ? {
        '3100/tcp': [{ HostIp: '127.0.0.1', HostPort: String(bridgePort) }]
      }
    : {};
  const exposed = {};
  if (screenEnabled) exposed['6080/tcp'] = {};
  if (isCompanion) exposed['3100/tcp'] = {};

  const container = await api.createContainer({
    name,
    Image: isCompanion ? config.companionImage : config.agentImage,
    Tty: true,
    OpenStdin: false,
    ExposedPorts: exposed,
    Env: [
      `AGENT_ID=${agent.id}`,
      `AGENT_KEY=${agent.api_key}`,
      `BACKEND_URL=http://egress:${config.backendPort}`,
      'AGENT_CONFIG=/workspace/.agent/config.json',
      'OLLAMA_HOST=http://127.0.0.1:11434',
      `ENABLE_SCREEN=${screenEnabled ? '1' : '0'}`,
      `SCREEN_WIDTH=${config.screenWidth}`,
      `SCREEN_HEIGHT=${config.screenHeight}`,
      'DISPLAY=:99',
      'TZ=Asia/Shanghai',
      'HOME=/root',
      ...(isCompanion
        ? [
            'EA_MODE=companion',
            'BRIDGE_DATA_DIR=/data',
            'BRIDGE_HOME=/opt/ai-qq-bridge',
            'BRIDGE_CONFIG=/data/config.json'
          ]
        : [])
    ],
    Labels: {
      'ea.role': 'agent',
      'ea.mode': isCompanion ? 'companion' : 'research',
      'ea.agent-id': agent.id
    },
    HostConfig: {
      Binds: [
        `${toDockerPath(hostWorkspace)}:/workspace`,
        `${toDockerPath(config.tmpWorkspaceDir)}:/tmp_workspace`,
        ...(isCompanion
          ? [`${toDockerPath(`${config.workspacesDir}/${agent.id}/.qq`)}:/data`]
          : []),
        ...(hostRulesFile && fs.existsSync(hostRulesFile)
          ? [`${toDockerPath(hostRulesFile)}:/PLATFORM_RULES.md:ro`]
          : []),
        ...toolkitBinds.map((item) => `${toDockerPath(item.host)}:${item.target}:ro`)
      ],
      NanoCpus: config.agentCpuCores * 1_000_000_000,
      Memory: screenEnabled ? config.agentScreenMemoryBytes : config.agentMemoryBytes,
      MemorySwap: screenEnabled ? config.agentScreenMemoryBytes : config.agentMemoryBytes,
      // WebKit/Chromium 在 64MB /dev/shm 下容易崩溃（浏览器窗口只剩标题栏或直接退出）
      ShmSize: screenEnabled ? 512 * 1024 * 1024 : 64 * 1024 * 1024,
      PidsLimit: config.agentPidsLimit,
      Init: true,
      AutoRemove: false,
      PortBindings: bridgePorts,
      ExtraHosts: [
        'host.docker.internal:127.0.0.1',
        'gateway.docker.internal:127.0.0.1'
      ],
      LogConfig: {
        Type: 'json-file',
        Config: { 'max-size': '50m', 'max-file': '3' }
      }
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [primaryNetwork]: { Aliases: [agent.id.toLowerCase()] }
      }
    }
  });

  await container.start();
  const info = await container.inspect();

  if (outboundNetwork) {
    try {
      await api.getNetwork(internalNetwork).connect({
        Container: info.Id,
        EndpointConfig: { Aliases: [agent.id.toLowerCase()] }
      });
    } catch (error) {
      const message = String(error.message || '');
      if (!message.includes('already exists') && !message.includes('already connected')) {
        throw error;
      }
    }
  }

  return {
    containerId: info.Id,
    containerName: name,
    networkName: internalNetwork,
    outboundNetwork
  };
}

async function startContainer(containerId) {
  if (!containerId) throw new Error('容器 ID 为空');
  const container = client().getContainer(containerId);
  const info = await container.inspect();
  if (info.State?.Running) return;
  await container.start();
}

async function stopContainer(containerId, timeout = 15) {
  if (!containerId) return;
  try {
    await client().getContainer(containerId).stop({ t: timeout });
  } catch (error) {
    if (error.statusCode !== 304 && error.statusCode !== 404) throw error;
  }
}

// 宿主 hosts 把 GitHub 域名指向 127.0.0.1，Docker 内嵌 DNS 会把该劫持带给容器。
// 每次容器启动时用实测可达的真实 IP 覆盖容器内 /etc/hosts。
const GITHUB_HOST_ENTRIES = [
  '20.27.177.113 github.com',
  '20.27.177.113 www.github.com',
  '140.82.112.6 api.github.com',
  '140.82.112.9 codeload.github.com',
  '140.82.112.3 gist.github.com',
  '185.199.111.133 raw.githubusercontent.com',
  '185.199.111.133 objects.githubusercontent.com',
  '185.199.111.133 gist.githubusercontent.com',
  '185.199.111.133 avatars.githubusercontent.com'
];

async function fixGithubHosts(containerId) {
  if (!containerId) return;
  const script = [
    'cp /etc/hosts /tmp/hosts.ea.bak 2>/dev/null || true',
    "grep -vE '^[0-9a-fA-F:.]+[[:space:]]+[^ #]*github' /etc/hosts > /tmp/hosts.ea && cat /tmp/hosts.ea > /etc/hosts",
    `printf '%s\\n' ${GITHUB_HOST_ENTRIES.map((line) => `'${line}'`).join(' ')} >> /etc/hosts`,
    'rm -f /tmp/hosts.ea'
  ].join('\n');

  const container = client().getContainer(containerId);
  const exec = await container.exec({
    Cmd: ['sh', '-c', script],
    AttachStdout: false,
    AttachStderr: false
  });
  await exec.start({ Detach: true });
}

async function removeContainer(containerId, force = true) {
  if (!containerId) return;
  try {
    await client().getContainer(containerId).remove({ force });
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
}

async function inspectContainer(containerId) {
  if (!containerId) return null;
  try {
    return await client().getContainer(containerId).inspect();
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

async function pauseContainer(containerId) {
  if (!containerId) return;
  try {
    await client().getContainer(containerId).pause();
  } catch (error) {
    if (error.statusCode !== 304) throw error;
  }
}

async function unpauseContainer(containerId) {
  if (!containerId) return;
  try {
    await client().getContainer(containerId).unpause();
  } catch (error) {
    if (error.statusCode !== 304) throw error;
  }
}

function streamLogs(agent, onLine) {
  const api = client();
  const container = api.getContainer(agent.container_id);
  let stream;
  let closed = false;
  let buffer = '';

  const finish = () => {
    if (closed) return;
    closed = true;
    try {
      stream?.destroy();
    } catch {
      // ignore
    }
    onLine('', 'system', { closed: true });
  };

  container.logs(
    { follow: true, stdout: true, stderr: true, tail: 0, timestamps: false },
    (error, result) => {
      if (error) {
        onLine(`[日志流错误] ${error.message}`, 'system', { error });
        finish();
        return;
      }
      stream = result;
      stream.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.length) onLine(line, 'stdout');
        }
      });
      stream.on('error', (streamError) => {
        onLine(`[日志流错误] ${streamError.message}`, 'system', { error: streamError });
        finish();
      });
      stream.on('end', finish);
      stream.on('close', finish);
    }
  );

  return () => {
    try {
      stream?.destroy();
    } catch {
      // ignore
    }
  };
}

async function getContainerSize(containerId) {
  try {
    const info = await client().df();
    const item = (info.Containers || []).find((c) => c.Id === containerId);
    return Number(item?.SizeRw || 0);
  } catch {
    return 0;
  }
}

async function getContainerSizes() {
  const map = new Map();
  try {
    const info = await client().df();
    for (const item of info.Containers || []) {
      map.set(item.Id, Number(item.SizeRw || 0));
    }
  } catch {
    // Docker 不可用时返回空表
  }
  return map;
}

async function removeAgentNetwork(seq) {
  const name = `ea-ai-${String(seq).padStart(3, '0')}`;
  try {
    const network = client().getNetwork(name);
    const egress = await inspectContainerByName(config.egressContainer);
    if (egress) {
      await network.disconnect({ Container: egress.Id, Force: true }).catch(() => {});
    }
    await network.remove();
  } catch (error) {
    if (error.statusCode !== 404) {
      // 网络可能仍被容器占用，忽略即可
    }
  }

  const outboundName = `${config.outboundNetworkPrefix}-${String(seq).padStart(3, '0')}`;
  try {
    await client().getNetwork(outboundName).remove();
  } catch (error) {
    if (error.statusCode !== 404) {
      // 网络可能仍被容器占用，忽略即可
    }
  }
}

module.exports = {
  client,
  isAvailable,
  imageExists,
  ensureControlNetwork,
  ensureEgress,
  ensureAgentNetwork,
  ensureOutboundNetwork,
  createAgentContainer,
  startContainer,
  stopContainer,
  removeContainer,
  inspectContainer,
  inspectContainerByName,
  pauseContainer,
  unpauseContainer,
  fixGithubHosts,
  streamLogs,
  getContainerSize,
  getContainerSizes,
  removeAgentNetwork
};
