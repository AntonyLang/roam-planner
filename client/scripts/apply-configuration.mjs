import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const addresses = { agent: 'http://127.0.0.1:8102', evaluation: 'http://127.0.0.1:8101', sources: 'http://127.0.0.1:8004' };
async function command(executable, args, root) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, shell: false, stdio: 'ignore' });
    child.once('error', () => reject(new Error('无法执行配置应用入口。')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('配置应用未完成，请检查服务状态后重试。')));
  });
}
export async function applyConfiguration({ root, store, services, request = fetch, run = command }) {
  const pending = await store.pending();
  const ready = new Set(services.filter(service => service.ready).map(service => service.id));
  const affected = pending.filter(id => ready.has(id));
  if (!affected.length) { await store.applied(pending); return; }
  const receipts = {};
  for (const [id, filename] of [['agent', 'node-agent-control.json'], ['evaluation', 'native-agent-control.json']]) {
    if (!ready.has(id)) continue;
    // Dependencies can be in use by either Agent or benchmark executions.
    const uses = id === 'agent' ? ['agent', 'sources', 'trek'] : ['evaluation', 'sources', 'trek'];
    if (!affected.some(service => uses.includes(service))) continue;
    if (id === 'agent') {
      const response = await request(addresses.agent + '/v1/tasks', { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('无法确认 Agent 是否空闲。');
      const state = await response.json();
      if (state.tasks.length || state.submissions.length) throw new Error('Agent 仍在执行任务；配置已保存，请在任务结束后应用。');
    }
    if (affected.includes(id) || id === 'evaluation') {
      try { receipts[id] = JSON.parse(await readFile(path.join(root, '.run', filename), 'utf8')); }
      catch { throw new Error('服务没有本机控制凭据，请使用项目启动入口重新启动后应用。'); }
    }
    if (id === 'evaluation') {
      const response = await request(addresses.evaluation + '/internal/native-status', { headers: { 'x-native-control': receipts.evaluation.token }, signal: AbortSignal.timeout(3000) });
      if (!response.ok || (await response.json()).busy) throw new Error('评测服务仍在执行任务或无法确认空闲；配置已保存，请稍后应用。');
    }
  }
  if (affected.includes('sources')) {
    const response = await request(addresses.sources + '/v1/retrieval', { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('无法确认检索实验状态。');
    if ((await response.json()).runs.some(run => ['running', 'queued'].includes(run.status))) throw new Error('检索实验仍在执行；配置已保存，请稍后应用。');
  }
  for (const id of ['evaluation', 'agent'].filter(id => affected.includes(id))) {
    const response = await request(addresses[id] + '/internal/native-shutdown', { method: 'POST', headers: { 'x-native-control': receipts[id].token }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('服务尚不能安全停止；配置已保存，请稍后应用。');
    let stopped = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      try { await request(addresses[id] + '/ready', { signal: AbortSignal.timeout(700) }); }
      catch { stopped = true; break; }
    }
    if (!stopped) throw new Error('服务尚未停止完成，请稍后重试应用。');
  }
  const containers = affected.filter(id => ['sources', 'trek'].includes(id)).map(id => id === 'sources' ? 'external-sources' : id);
  if (containers.length) await run('docker.exe', ['compose', '-f', 'compose.agent.yaml', '-f', 'compose.native.yaml', 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90', ...containers], root);
  for (const id of ['agent', 'evaluation'].filter(id => affected.includes(id))) {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, id === 'agent' ? 'agent/tools/start_native.ps1' : 'old/tools/start_evaluation.ps1'), ...(id === 'agent' ? ['-AgentOnly', '-NoBuild'] : [])], root);
  }
  if (containers.length && ready.has('agent')) {
    const response = await request(addresses.agent + '/v1/mcp/connect', { method: 'POST', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('服务已重新加载，Agent 的 MCP 连接仍需重试。');
  }
  await store.applied(pending);
}
