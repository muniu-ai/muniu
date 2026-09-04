import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "./Status";

export class PluginBoundary extends Component<
  { readonly pluginName: string; readonly children: ReactNode },
  { readonly error?: Error }
> {
  state: { readonly error?: Error } = {};

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(_error: Error, _info: ErrorInfo) {}

  render() {
    if (this.state.error) {
      return <ErrorState title={`${this.props.pluginName} 已降级`} detail="这个插件暂时不可用，其他功能不受影响" action="在活动页查看故障记录，修复后重试" onRetry={() => this.setState({ error: undefined })} />;
    }
    return this.props.children;
  }
}
