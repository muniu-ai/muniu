import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelPresetV2 } from "@mn/contracts";
import { ArrowLeft, ArrowRight, BriefcaseBusiness, Check, Code2, Eye, KeyRound, Rocket, ShieldCheck, Sparkles } from "lucide-react";
import { AgentOsApiError, AgentOsClient } from "./api";
import { ErrorState } from "./components/Status";
import { BrandMark } from "./components/BrandMark";
import { RunnerConfiguration } from "./components/RunnerConfiguration";
import type { ProductPluginId, ViewMode, WorkspaceSummary } from "./types";

export type BusinessStart = "plan" | "customers" | "orders";

interface OnboardingProps {
  readonly api: AgentOsClient;
  readonly onComplete: (workspace: WorkspaceSummary, businessStart?: BusinessStart) => void;
}

type StartPath = "records" | "builtin" | "external";
const steps = ["选择视图", "启用插件", "开始方式", "开始工作"] as const;
export function Onboarding({ api, onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("business");
  const [plugins, setPlugins] = useState<readonly ProductPluginId[]>(["opc"]);
  const [presets, setPresets] = useState<readonly ModelPresetV2[]>([]);
  const [presetId, setPresetId] = useState("");
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetsError, setPresetsError] = useState<string>();
  const [apiKey, setApiKey] = useState("");
  const [startPath, setStartPath] = useState<StartPath>("records");
  const [workspaceName, setWorkspaceName] = useState("我的业务");
  const [firstInput, setFirstInput] = useState("");
  const [businessStart, setBusinessStart] = useState<BusinessStart>("plan");
  const [runSample, setRunSample] = useState(true);
  const [busy, setBusy] = useState(false);
  const [createdWorkspace, setCreatedWorkspace] = useState<WorkspaceSummary>();
  const [checkingExternal, setCheckingExternal] = useState(false);
  const checkpoints = useRef<{ setup: boolean; model?: { input: string; id: string; probed: boolean }; repository: boolean; sample: boolean }>({ setup: false, repository: false, sample: false });
  const requestKeys = useRef(new Map<string, string>());
  const [error, setError] = useState<{
    readonly stage: string;
    readonly message: string;
    readonly action: string;
    readonly code?: string;
    readonly traceId?: string;
  }>();
  const primaryPlugin = plugins[0] ?? "opc";
  const loadPresets = useCallback(async () => {
    setPresetsLoading(true); setPresetsError(undefined);
    try {
      const available = await api.modelPresets();
      setPresets(available);
      setPresetId(current => available.some(preset => preset.id === current) ? current : available[0]?.id ?? "");
    } catch { setPresetsError("无法读取模型厂商，请重试。也可以先整理记录或连接外部 Agent。"); }
    finally { setPresetsLoading(false); }
  }, [api]);
  useEffect(() => { void loadPresets(); }, [loadPresets]);
  const canContinue = useMemo(() => {
    if (step === 1) return plugins.length > 0;
    if (step === 2) return startPath !== "builtin" || (apiKey.trim().length > 0 && presets.some(preset => preset.id === presetId));
    if (step === 3) return workspaceName.trim().length > 0 && (primaryPlugin !== "coding" || firstInput.trim().length > 0);
    return true;
  }, [apiKey, firstInput, plugins, presetId, presets, primaryPlugin, startPath, step, workspaceName]);

  function requestKey(operation: string, input: unknown = null) {
    const fingerprint = JSON.stringify([operation, input]);
    let key = requestKeys.current.get(fingerprint);
    if (!key) { key = crypto.randomUUID(); requestKeys.current.set(fingerprint, key); }
    return key;
  }

  function complete(workspace: WorkspaceSummary) {
    localStorage.setItem("muniu:v2:onboarding-complete", "1");
    onComplete(workspace, plugins.includes("opc") ? businessStart : undefined);
  }

  function togglePlugin(pluginId: ProductPluginId) {
    setPlugins((current) => current.includes(pluginId)
      ? current.filter((candidate) => candidate !== pluginId)
      : [...current, pluginId]);
  }

  async function finish() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    let stage = "初始化设置";
    try {
      if (!checkpoints.current.setup) {
        await api.setup(requestKey("setup"));
        checkpoints.current.setup = true;
      }
      if (startPath === "builtin") {
        stage = "保存模型密钥";
        const input = JSON.stringify([presetId, apiKey.trim()]);
        if (checkpoints.current.model?.input !== input) {
          const connection = await api.connectModel(presetId, apiKey.trim(), requestKey("model", input));
          checkpoints.current.model = { input, id: connection.id, probed: false };
        }
        stage = "验证模型连接";
        const model = checkpoints.current.model;
        if (!model.probed) {
          await api.probeModel(model.id, 1, false, requestKey("probe", model.id));
          model.probed = true;
        }
      }
      stage = "创建工作区";
      const workspace = createdWorkspace ?? await api.createWorkspace(workspaceName.trim(), viewMode, plugins, requestKey("workspace", [workspaceName.trim(), viewMode, plugins]));
      setCreatedWorkspace(workspace);
      if (primaryPlugin === "coding" && !checkpoints.current.repository) {
        stage = "添加仓库";
        await api.createFirstObject(workspace.id, primaryPlugin, firstInput.trim(), requestKey("repository", [workspace.id, firstInput.trim()]));
        checkpoints.current.repository = true;
      }
      if (runSample && !checkpoints.current.sample) {
        stage = "运行只读样例";
        await api.runReadOnlySample(workspace.id, primaryPlugin, requestKey("sample", [workspace.id, primaryPlugin]));
        checkpoints.current.sample = true;
      }
      stage = "保存设置";
      if (startPath === "external") setCheckingExternal(true);
      else complete(workspace);
    } catch (caught) {
      const detail = caught instanceof AgentOsApiError
        ? caught.detail
        : { message: "设置未完成", action: "检查 Host 是否运行，然后重试" };
      setError({ stage, message: detail.message, action: detail.action,
        ...(caught instanceof AgentOsApiError ? { code: caught.detail.code, traceId: caught.detail.traceId } : {}),
      });
    } finally {
      setBusy(false);
    }
  }

  return <main className="onboarding-shell">
    <section className="onboarding-card" aria-labelledby="onboarding-title">
      <header className="onboarding-header">
        <BrandMark />
        <div><p className="eyebrow">木牛 Agent OS</p><h1 id="onboarding-title">四步建立你的工作台</h1><p>先选适合你的视图。技术配置以后都能调整。</p></div>
      </header>

      <ol className="stepper" aria-label="设置进度">
        {steps.map((label, index) => <li key={label} className={index === step ? "active" : index < step ? "done" : ""} aria-current={index === step ? "step" : undefined}>
          <span>{index < step ? <Check size={14} /> : index + 1}</span><small>{label}</small>
        </li>)}
      </ol>

      <div className="onboarding-body">
        {step === 0 && <section className="setup-screen" aria-labelledby="view-title">
          <div className="screen-heading"><Eye size={22} /><div><h2 id="view-title">你希望先看到什么</h2><p>两种视图使用同一数据和操作，随时可以切换。</p></div></div>
          <div className="choice-grid two">
            <button className={`choice-card ${viewMode === "business" ? "selected" : ""}`} onClick={() => setViewMode("business")} aria-pressed={viewMode === "business"}>
              <BriefcaseBusiness size={24} /><strong>经营视图</strong><p>先看客户、订单、交付和收支。按业务安排下一步。</p><span>适合专注业务推进</span>
            </button>
            <button className={`choice-card ${viewMode === "professional" ? "selected" : ""}`} onClick={() => setViewMode("professional")} aria-pressed={viewMode === "professional"}>
              <Code2 size={24} /><strong>专业视图</strong><p>原位展开执行、事件、预算和工具详情。</p><span>适合调试与治理</span>
            </button>
          </div>
        </section>}

        {step === 1 && <section className="setup-screen" aria-labelledby="plugin-title">
          <div className="screen-heading"><Sparkles size={22} /><div><h2 id="plugin-title">选择现在要做的事</h2><p>官方插件已随应用安装，只在这个工作区启用。</p></div></div>
          <div className="choice-grid two">
            <button className={`choice-card ${plugins.includes("opc") ? "selected" : ""}`} onClick={() => togglePlugin("opc")} aria-pressed={plugins.includes("opc")}>
              <BriefcaseBusiness size={24} /><strong>OPC 经营管理</strong><p>制定经营计划，管理客户、产品、报价、订单、交付与收支。</p><span>服务与项目型业务；机会验证作为探索入口</span>
            </button>
            <button className={`choice-card ${plugins.includes("coding") ? "selected" : ""}`} onClick={() => togglePlugin("coding")} aria-pressed={plugins.includes("coding")}>
              <Code2 size={24} />
              <strong>Coding</strong>
              <p>从需求到差异、检查、审批和代码证据。</p>
              <span>可先登记仓库，再连接内置或外部 Agent</span>
            </button>
          </div>
          <aside className="trust-note"><ShieldCheck size={18} /><p><strong>关于插件信任</strong>生产插件与木牛 Host 进程权限等价，不是沙箱。安装第三方插件前会展示权限、来源、许可证、版本和签名结果。</p></aside>
        </section>}

        {step === 2 && <section className="setup-screen" aria-labelledby="model-title">
          <div className="screen-heading"><KeyRound size={22} /><div><h2 id="model-title">选择开始方式</h2><p>记录业务和登记仓库无需模型。开始 Agent 任务时再检查执行条件。</p></div></div>
          <div className="preset-list" role="group" aria-label="开始方式">
            <button className={startPath === "records" ? "selected" : ""} aria-label="先整理记录" aria-pressed={startPath === "records"} onClick={() => setStartPath("records")}><span><strong>先整理记录</strong><small>登记业务或仓库，稍后连接 Agent</small></span></button>
            <button className={startPath === "builtin" ? "selected" : ""} aria-label="连接内置模型" aria-pressed={startPath === "builtin"} onClick={() => setStartPath("builtin")}><span><strong>连接内置模型</strong><small>使用模型厂商的 API Key</small></span></button>
            <button className={startPath === "external" ? "selected" : ""} aria-label="连接外部 Agent" aria-pressed={startPath === "external"} onClick={() => setStartPath("external")}><span><strong>连接外部 Agent</strong><small>检查 Codex 或 Claude Code</small></span></button>
          </div>
          {startPath === "records" && <p>先建立工作区。客户、订单和仓库记录可以直接管理，执行 Agent 任务前再连接模型或外部 Agent。</p>}
          {startPath === "external" && <p>外部 Agent 使用自己的账户和模型，无需填写木牛 API Key。创建工作区后检查插件、安装文件、文件身份和执行条件；登录状态以实际检查结果为准。</p>}
          {startPath === "builtin" && <>
          <div className="preset-list">
            {presets.map((preset) => <button key={preset.id} className={presetId === preset.id ? "selected" : ""} onClick={() => setPresetId(preset.id)} aria-label={preset.displayName} aria-pressed={presetId === preset.id}>
              <span className="provider-dot">{preset.displayName.slice(0, 1)}</span><span><strong>{preset.displayName}</strong><small>{preset.suggestedModels.join(" · ")}</small></span>{presetId === preset.id && <Check size={17} />}
            </button>)}
          </div>
          {presetsLoading && <p role="status">正在读取模型厂商…</p>}
          {presetsError && <p role="alert">{presetsError}<button className="quiet-button" onClick={() => void loadPresets()}>重新读取</button></p>}
          <p>此连接供木牛内置 Agent 使用。选择厂商并填写密钥。</p>
          <label className="field"><span>API Key</span><input aria-label="API Key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" placeholder="密钥只保存在 macOS Keychain" /><small>不会写入配置文件、日志或导出物</small></label>
          </>}
        </section>}

        {step === 3 && !checkingExternal && <section className="setup-screen" aria-labelledby="workspace-title">
          <div className="screen-heading"><Rocket size={22} /><div><h2 id="workspace-title">创建第一个工作区</h2><p>会话按工作区和业务对象组织，不按聊天时间堆叠。</p></div></div>
          {createdWorkspace && <p role="status">工作区已创建，重试将继续未完成的步骤。</p>}
          <div className="form-stack">
            <label className="field"><span>工作区名称</span><input value={workspaceName} disabled={busy || Boolean(createdWorkspace)} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="例如 独立设计师增长" /></label>
            {plugins.includes("opc") && <fieldset className="business-start" disabled={busy}><legend>从哪里开始</legend>
              <label className="check-row"><input type="radio" name="business-start" checked={businessStart === "plan"} onChange={() => setBusinessStart("plan")} /><span><strong>探索新业务</strong><small>先明确经营方向，按需开展机会验证</small></span></label>
              <label className="check-row"><input type="radio" name="business-start" checked={businessStart === "customers"} onChange={() => setBusinessStart("customers")} aria-label="已有客户" /><span><strong>已有客户</strong><small>登记客户需求，准备产品和正式报价</small></span></label>
              <label className="check-row"><input type="radio" name="business-start" checked={businessStart === "orders"} onChange={() => setBusinessStart("orders")} /><span><strong>已有订单</strong><small>根据原合同录入交付义务、历史已收和未结款项</small></span></label>
            </fieldset>}
            {primaryPlugin === "coding" && <label className="field"><span>第一个仓库</span><input value={firstInput} disabled={busy || checkpoints.current.repository} onChange={(event) => setFirstInput(event.target.value)} placeholder="本机仓库的绝对路径" /></label>}
            <label className="check-row"><input type="checkbox" checked={runSample} disabled={busy} onChange={(event) => setRunSample(event.target.checked)} /><span><strong>检查插件启用状态</strong><small>只记录本地检查，不调用模型或访问外部数据</small></span></label>
          </div>
        </section>}
        {checkingExternal && createdWorkspace && <>
          <p role="status">工作区已创建。完成接入检查后可进入工作台，也可以稍后在设置中继续。</p>
          <RunnerConfiguration api={api} workspace={createdWorkspace} onChanged={setCreatedWorkspace} />
        </>}
      </div>

      {error && <>
        <ErrorState title={`${error.stage}未完成`} detail={error.message} action={error.action} />
        {error.code && <details className="technical-details"><summary>故障详情</summary><p><small>错误码：<code>{error.code}</code><br />参考编号：<code>{error.traceId}</code></small></p></details>}
      </>}
      <footer className="onboarding-actions">
        <button className="secondary-button" disabled={step === 0 || busy || Boolean(createdWorkspace)} onClick={() => setStep((current) => current - 1)}><ArrowLeft size={16} />上一步</button>
        {checkingExternal && createdWorkspace
          ? <button className="primary-button" onClick={() => complete(createdWorkspace)}>进入工作台<ArrowRight size={16} /></button>
          : step < steps.length - 1
          ? <button className="primary-button" disabled={!canContinue || busy} onClick={() => setStep((current) => current + 1)}>继续<ArrowRight size={16} /></button>
          : <button className="primary-button" disabled={!canContinue || busy} onClick={finish}>{busy ? "正在创建" : startPath === "external" ? "创建并检查 Agent" : "进入工作台"}<ArrowRight size={16} /></button>}
      </footer>
    </section>
  </main>;
}
