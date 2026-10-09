import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelPresetV2 } from "@mn/contracts";
import { ArrowLeft, ArrowRight, BriefcaseBusiness, Check, Code2, Eye, KeyRound, Rocket, ShieldCheck, Sparkles } from "lucide-react";
import { AgentOsApiError, AgentOsClient } from "./api";
import { ErrorState } from "./components/Status";
import { BrandMark } from "./components/BrandMark";
import type { ProductPluginId, ViewMode, WorkspaceSummary } from "./types";

export type BusinessStart = "plan" | "customers" | "orders";

interface OnboardingProps {
  readonly api: AgentOsClient;
  readonly onComplete: (workspace: WorkspaceSummary, businessStart?: BusinessStart) => void;
}

const steps = ["选择视图", "启用插件", "连接模型", "开始工作"] as const;
export function Onboarding({ api, onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("business");
  const [plugins, setPlugins] = useState<readonly ProductPluginId[]>(["opc"]);
  const [presets, setPresets] = useState<readonly ModelPresetV2[]>([]);
  const [presetId, setPresetId] = useState("");
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetsError, setPresetsError] = useState<string>();
  const [apiKey, setApiKey] = useState("");
  const [workspaceName, setWorkspaceName] = useState("我的业务");
  const [firstInput, setFirstInput] = useState("");
  const [businessStart, setBusinessStart] = useState<BusinessStart>("plan");
  const [runSample, setRunSample] = useState(true);
  const [busy, setBusy] = useState(false);
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
    } catch { setPresetsError("无法读取模型厂商，请重试。经营记录可以先跳过模型连接。"); }
    finally { setPresetsLoading(false); }
  }, [api]);
  useEffect(() => { void loadPresets(); }, [loadPresets]);
  const canContinue = useMemo(() => {
    if (step === 1) return plugins.length > 0;
    if (step === 2) return apiKey.trim().length > 0 ? presets.some(preset => preset.id === presetId) : !plugins.includes("coding");
    if (step === 3) return workspaceName.trim().length > 0 && (primaryPlugin !== "coding" || firstInput.trim().length > 0);
    return true;
  }, [apiKey, firstInput, plugins, presetId, presets, primaryPlugin, step, workspaceName]);

  function togglePlugin(pluginId: ProductPluginId) {
    setPlugins((current) => current.includes(pluginId)
      ? current.filter((candidate) => candidate !== pluginId)
      : [...current, pluginId]);
  }

  async function finish() {
    setBusy(true);
    setError(undefined);
    let stage = "初始化设置";
    try {
      await api.setup();
      if (apiKey.trim()) {
        stage = "保存模型密钥";
        const connection = await api.connectModel(presetId, apiKey.trim());
        stage = "验证模型连接";
        await api.probeModel(connection.id);
      }
      stage = "创建工作区";
      const workspace = await api.createWorkspace(workspaceName.trim(), viewMode, plugins);
      if (primaryPlugin === "coding") {
        stage = "添加仓库";
        await api.createFirstObject(workspace.id, primaryPlugin, firstInput.trim());
      }
      if (runSample) {
        stage = "运行只读样例";
        await api.runReadOnlySample(workspace.id, primaryPlugin);
      }
      stage = "保存设置";
      localStorage.setItem("muniu:v2:onboarding-complete", "1");
      onComplete(workspace, plugins.includes("opc") ? businessStart : undefined);
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
              <span>Builtin Agent 默认执行</span>
            </button>
          </div>
          <aside className="trust-note"><ShieldCheck size={18} /><p><strong>关于插件信任</strong>生产插件与木牛 Host 进程权限等价，不是沙箱。安装第三方插件前会展示权限、来源、许可证、版本和签名结果。</p></aside>
        </section>}

        {step === 2 && <section className="setup-screen" aria-labelledby="model-title">
          <div className="screen-heading"><KeyRound size={22} /><div><h2 id="model-title">连接你的模型</h2><p>{plugins.includes("coding") ? "Coding 需要可用模型。选择厂商并填写密钥。" : "经营记录无需模型，可直接继续。首次使用 Agent 时再连接模型。"}</p></div></div>
          <div className="preset-list">
            {presets.map((preset) => <button key={preset.id} className={presetId === preset.id ? "selected" : ""} onClick={() => setPresetId(preset.id)} aria-label={preset.displayName} aria-pressed={presetId === preset.id}>
              <span className="provider-dot">{preset.displayName.slice(0, 1)}</span><span><strong>{preset.displayName}</strong><small>{preset.suggestedModels.join(" · ")}</small></span>{presetId === preset.id && <Check size={17} />}
            </button>)}
          </div>
          {presetsLoading && <p role="status">正在读取模型厂商…</p>}
          {presetsError && <p role="alert">{presetsError}<button className="quiet-button" onClick={() => void loadPresets()}>重新读取</button></p>}
          <p>这些连接供木牛内置 Agent 使用。Codex、Claude Code 等外部 Agent 在设置中单独检查和授权。</p>
          <label className="field"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" placeholder="密钥只保存在 macOS Keychain" /><small>不会写入配置文件、日志或导出物</small></label>
        </section>}

        {step === 3 && <section className="setup-screen" aria-labelledby="workspace-title">
          <div className="screen-heading"><Rocket size={22} /><div><h2 id="workspace-title">创建第一个工作区</h2><p>会话按工作区和业务对象组织，不按聊天时间堆叠。</p></div></div>
          <div className="form-stack">
            <label className="field"><span>工作区名称</span><input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="例如 独立设计师增长" /></label>
            {plugins.includes("opc") && <fieldset className="business-start"><legend>从哪里开始</legend>
              <label className="check-row"><input type="radio" name="business-start" checked={businessStart === "plan"} onChange={() => setBusinessStart("plan")} /><span><strong>探索新业务</strong><small>先明确经营方向，按需开展机会验证</small></span></label>
              <label className="check-row"><input type="radio" name="business-start" checked={businessStart === "customers"} onChange={() => setBusinessStart("customers")} aria-label="已有客户" /><span><strong>已有客户</strong><small>登记客户需求，准备产品和正式报价</small></span></label>
              <label className="check-row"><input type="radio" name="business-start" checked={businessStart === "orders"} onChange={() => setBusinessStart("orders")} /><span><strong>已有订单</strong><small>根据原合同录入交付义务、历史已收和未结款项</small></span></label>
            </fieldset>}
            {primaryPlugin === "coding" && <label className="field"><span>第一个仓库</span><input value={firstInput} onChange={(event) => setFirstInput(event.target.value)} placeholder="本机仓库的绝对路径" /></label>}
            <label className="check-row"><input type="checkbox" checked={runSample} onChange={(event) => setRunSample(event.target.checked)} /><span><strong>检查插件启用状态</strong><small>只记录本地检查，不调用模型或访问外部数据</small></span></label>
          </div>
        </section>}
      </div>

      {error && <>
        <ErrorState title={`${error.stage}未完成`} detail={error.message} action={error.action} />
        {error.code && <details className="technical-details"><summary>故障详情</summary><p><small>错误码：<code>{error.code}</code><br />参考编号：<code>{error.traceId}</code></small></p></details>}
      </>}
      <footer className="onboarding-actions">
        <button className="secondary-button" disabled={step === 0 || busy} onClick={() => setStep((current) => current - 1)}><ArrowLeft size={16} />上一步</button>
        {step < steps.length - 1
          ? <button className="primary-button" disabled={!canContinue || busy} onClick={() => setStep((current) => current + 1)}>继续<ArrowRight size={16} /></button>
          : <button className="primary-button" disabled={!canContinue || busy} onClick={finish}>{busy ? "正在创建" : "进入工作台"}<ArrowRight size={16} /></button>}
      </footer>
    </section>
  </main>;
}
