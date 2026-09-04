import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, BriefcaseBusiness, Check, Code2, Eye, KeyRound, Rocket, ShieldCheck, Sparkles } from "lucide-react";
import { AgentOsApiError, AgentOsClient } from "./api";
import { ErrorState } from "./components/Status";
import type { ProductPluginId, ViewMode, WorkspaceSummary } from "./types";

interface OnboardingProps {
  readonly api: AgentOsClient;
  readonly onComplete: (workspace: WorkspaceSummary) => void;
}

const steps = ["选择视图", "启用插件", "连接模型", "开始工作"] as const;
const presets = [
  { id: "openai", name: "OpenAI", hint: "推荐用于通用推理与 Coding" },
  { id: "anthropic", name: "Anthropic", hint: "适合长上下文与代码任务" },
  { id: "deepseek", name: "DeepSeek", hint: "适合中文研究与代码任务" },
] as const;

export function Onboarding({ api, onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("business");
  const [plugins, setPlugins] = useState<readonly ProductPluginId[]>(["opc"]);
  const [presetId, setPresetId] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [workspaceName, setWorkspaceName] = useState("我的业务");
  const [firstInput, setFirstInput] = useState("帮助独立设计师更稳定地获得高质量客户");
  const [runSample, setRunSample] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ readonly message: string; readonly action: string }>();
  const primaryPlugin = plugins[0] ?? "opc";
  const canContinue = useMemo(() => {
    if (step === 1) return plugins.length > 0;
    if (step === 2) return apiKey.trim().length > 0;
    if (step === 3) return workspaceName.trim().length > 0 && firstInput.trim().length > 0;
    return true;
  }, [apiKey, firstInput, plugins.length, step, workspaceName]);

  function togglePlugin(pluginId: ProductPluginId) {
    setPlugins((current) => current.includes(pluginId)
      ? current.filter((candidate) => candidate !== pluginId)
      : [...current, pluginId]);
  }

  async function finish() {
    setBusy(true);
    setError(undefined);
    try {
      await api.setup();
      const connection = await api.connectModel(presetId, apiKey.trim());
      await api.probeModel(connection.id);
      const workspace = await api.createWorkspace(workspaceName.trim(), viewMode, plugins);
      await api.createFirstObject(workspace.id, primaryPlugin, firstInput.trim());
      if (runSample) await api.runReadOnlySample(workspace.id, primaryPlugin);
      localStorage.setItem("muniu:v2:onboarding-complete", "1");
      onComplete(workspace);
    } catch (caught) {
      const detail = caught instanceof AgentOsApiError
        ? caught.detail
        : { message: "设置未完成", action: "检查 Host 是否运行，然后重试" };
      setError({ message: detail.message, action: detail.action });
    } finally {
      setBusy(false);
    }
  }

  return <main className="onboarding-shell">
    <section className="onboarding-card" aria-labelledby="onboarding-title">
      <header className="onboarding-header">
        <div className="brand-mark"><span>木</span></div>
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
              <BriefcaseBusiness size={24} /><strong>经营视图</strong><p>先看机会、证据、决定和下一步。隐藏内部技术名称。</p><span>适合专注业务推进</span>
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
              <BriefcaseBusiness size={24} /><strong>OPC 机会验证</strong><p>发现机会、整理证据、准备访谈并形成最小收费方案。</p><span>不自动外联、发布或收款</span>
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
          <div className="screen-heading"><KeyRound size={22} /><div><h2 id="model-title">连接你的模型</h2><p>选择厂商并填写密钥。木牛会探测连接并选择默认模型。</p></div></div>
          <div className="preset-list">
            {presets.map((preset) => <button key={preset.id} className={presetId === preset.id ? "selected" : ""} onClick={() => setPresetId(preset.id)} aria-pressed={presetId === preset.id}>
              <span className="provider-dot">{preset.name.slice(0, 1)}</span><span><strong>{preset.name}</strong><small>{preset.hint}</small></span>{presetId === preset.id && <Check size={17} />}
            </button>)}
          </div>
          <label className="field"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" placeholder="密钥只保存在 macOS Keychain" /><small>不会写入配置文件、日志或导出物</small></label>
        </section>}

        {step === 3 && <section className="setup-screen" aria-labelledby="workspace-title">
          <div className="screen-heading"><Rocket size={22} /><div><h2 id="workspace-title">创建第一个工作区</h2><p>会话按工作区和业务对象组织，不按聊天时间堆叠。</p></div></div>
          <div className="form-stack">
            <label className="field"><span>工作区名称</span><input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="例如 独立设计师增长" /></label>
            <label className="field"><span>{primaryPlugin === "opc" ? "第一条机会" : "第一个仓库或任务"}</span><textarea value={firstInput} onChange={(event) => setFirstInput(event.target.value)} rows={3} /><small>木牛会生成可审阅对象，不会直接执行高风险操作</small></label>
            <label className="check-row"><input type="checkbox" checked={runSample} onChange={(event) => setRunSample(event.target.checked)} /><span><strong>运行只读样例</strong><small>确认模型和插件可以工作，不会修改外部数据</small></span></label>
          </div>
        </section>}
      </div>

      {error && <ErrorState detail={error.message} action={error.action} />}
      <footer className="onboarding-actions">
        <button className="secondary-button" disabled={step === 0 || busy} onClick={() => setStep((current) => current - 1)}><ArrowLeft size={16} />上一步</button>
        {step < steps.length - 1
          ? <button className="primary-button" disabled={!canContinue || busy} onClick={() => setStep((current) => current + 1)}>继续<ArrowRight size={16} /></button>
          : <button className="primary-button" disabled={!canContinue || busy} onClick={finish}>{busy ? "正在创建" : "进入工作台"}<ArrowRight size={16} /></button>}
      </footer>
    </section>
  </main>;
}
