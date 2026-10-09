// SPDX-License-Identifier: Apache-2.0

export function BrandMark({ small = false }: { readonly small?: boolean }) {
  return <span className={`brand-mark${small ? " small" : ""}`}>
    <img src="/brand/muniu-logo.png" alt="木牛标志" />
  </span>;
}
