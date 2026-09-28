#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

cluster_name="${MN_KIND_CLUSTER_NAME:-muniu-v2}"
namespace="muniu-kind"
image="muniu-kind:ci"
calico_version="v3.31.6"
cluster_created=false
calico_manifest=""

cleanup() {
  if [[ -n "${calico_manifest}" ]]; then
    rm -f -- "${calico_manifest}"
  fi
  if [[ "${MN_KIND_KEEP:-0}" != "1" && "${cluster_created}" == "true" ]]; then
    kind delete cluster --name "${cluster_name}" >/dev/null 2>&1 || true
  fi
}

diagnose() {
  kubectl --namespace "${namespace}" get pods,deployments,jobs,services -o wide || true
  kubectl --namespace "${namespace}" get events --sort-by=.lastTimestamp | tail -n 150 || true
  kubectl --namespace "${namespace}" logs deployment/muniu-host --all-pods=true --tail=200 || true
  kubectl --namespace "${namespace}" logs deployment/muniu-worker --all-pods=true --tail=200 || true
  kubectl --namespace "${namespace}" logs job/muniu-sandbox-probe --all-containers=true || true
}

finish() {
  local result="$?"
  if [[ "${result}" != "0" && "${cluster_created}" == "true" ]]; then
    diagnose
  fi
  cleanup
  return "${result}"
}
trap finish EXIT

for command in docker kind kubectl helm curl; do
  command -v "${command}" >/dev/null || { echo "缺少命令：${command}" >&2; exit 127; }
done
node_image="$(node scripts/lib/kind-node-image.mjs)"
if kind get clusters | grep -Fxq "${cluster_name}"; then
  echo "Kind 集群 ${cluster_name} 已存在；为避免删除用户状态，本次验证拒绝覆盖" >&2
  exit 1
fi

docker build --tag "${image}" .
kind create cluster --name "${cluster_name}" --config deploy/kind/config.yaml --image "${node_image}"
cluster_created=true
node scripts/lib/kind-runtime.mjs "${cluster_name}"

configured_pids_limit="$(docker exec "${cluster_name}-control-plane" awk '$1 == "podPidsLimit:" { print $2 }' /var/lib/kubelet/config.yaml)"
if [[ "${configured_pids_limit}" != "256" ]]; then
  echo "Kind kubelet podPidsLimit=${configured_pids_limit:-unset}，预期为 256" >&2
  exit 1
fi

calico_images=(
  "quay.io/calico/cni:${calico_version}"
  "quay.io/calico/kube-controllers:${calico_version}"
  "quay.io/calico/node:${calico_version}"
)
dependency_images=(
  "postgres:16-alpine"
)
minio_image="mn-minio-fixture:2025-04"
docker build --file deploy/fixtures/minio.Dockerfile --tag "${minio_image}" deploy/fixtures
vault_image="hashicorp/vault:1.21.4@sha256:4e33b126a59c0c333b76fb4e894722462659a6bec7c48c9ee8cea56fccfd2569"
for dependency in "${calico_images[@]}" "${dependency_images[@]}" "${vault_image}"; do
  docker image inspect "${dependency}" >/dev/null 2>&1 || docker pull "${dependency}"
done
vault_import_image="$(node scripts/lib/kind-vault-image.mjs "${cluster_name}" --import-reference)"
kind load docker-image "${image}" "${calico_images[@]}" "${dependency_images[@]}" "${minio_image}" "${vault_import_image}" --name "${cluster_name}"
sandbox_image_digest="$(node scripts/lib/kind-sandbox-image.mjs "${cluster_name}")"
calico_manifest="$(mktemp -t muniu-calico.XXXXXXXX)"
curl --http1.1 --fail --location --retry 3 --retry-all-errors \
  --ipv4 --silent --show-error \
  --connect-timeout 10 --max-time 120 \
  --output "${calico_manifest}" \
  "https://raw.githubusercontent.com/projectcalico/calico/${calico_version}/manifests/calico.yaml"
kubectl apply -f "${calico_manifest}"
kubectl --namespace kube-system rollout status daemonset/calico-node --timeout=300s
kubectl --namespace kube-system rollout status deployment/calico-kube-controllers --timeout=300s
kubectl wait --for=condition=Ready node --all --timeout=300s

for storage_path in \
  /var/local/muniu-kind-sandboxes \
  /var/local/muniu-kind-postgres-v2 \
  /var/local/muniu-kind-minio-v2; do
  docker exec "${cluster_name}-control-plane" mkdir -p "${storage_path}"
  docker exec "${cluster_name}-control-plane" chmod 0777 "${storage_path}"
done

kubectl create namespace "${namespace}"
kubectl label namespace "${namespace}" kubernetes.io/metadata.name="${namespace}" --overwrite
image_digest="$(docker image inspect --format '{{.Id}}' "${image}")"
image_digest="${image_digest#sha256:}"
if [[ ! "${image_digest}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "无法解析 fixture 镜像摘要" >&2
  exit 1
fi
kubectl --namespace "${namespace}" create configmap muniu-kind-image --from-literal="digest=${image_digest}"
node scripts/lib/kind-vault-image.mjs "${cluster_name}" | kubectl apply -f -
kubectl --namespace "${namespace}" rollout status deployment/muniu-kind-postgres --timeout=180s
kubectl --namespace "${namespace}" rollout status deployment/muniu-kind-minio --timeout=180s
kubectl --namespace "${namespace}" rollout status deployment/muniu-kind-vault --timeout=180s
kubectl --namespace "${namespace}" rollout status deployment/muniu-kind-fixture --timeout=180s
kubectl --namespace "${namespace}" wait --for=condition=Complete job/muniu-kind-minio-init --timeout=180s
kubectl --namespace "${namespace}" wait --for=condition=Complete job/muniu-kind-vault-init --timeout=180s

control_plane_ip="$(docker inspect --format '{{(index .NetworkSettings.Networks "kind").IPAddress}}' "${cluster_name}-control-plane")"
if [[ ! "${control_plane_ip}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "无法解析 Kind control-plane IP" >&2
  exit 1
fi

helm upgrade --install muniu deploy/helm/muniu \
  --namespace "${namespace}" \
  --values deploy/helm/muniu/values-kind.yaml \
  --set-string "sandbox.image=muniu-kind" \
  --set-string "sandbox.imageDigest=${sandbox_image_digest}" \
  --set-string "networkPolicy.kubernetesApiEgress[1].ipBlock.cidr=${control_plane_ip}/32" \
  --wait \
  --timeout 5m || { diagnose; exit 1; }
kubectl --namespace "${namespace}" rollout status deployment/muniu-host --timeout=180s
kubectl --namespace "${namespace}" rollout status deployment/muniu-worker --timeout=180s
kubectl --namespace "${namespace}" exec deployment/muniu-worker -- node scripts/enterprise-idle-transaction-proof.mjs

kubectl apply -f deploy/kind/sandbox-probe.yaml
kubectl --namespace "${namespace}" wait --for=condition=Complete job/muniu-sandbox-probe --timeout=180s || { diagnose; exit 1; }
probe_output="$(kubectl --namespace "${namespace}" logs job/muniu-sandbox-probe)"
printf '%s\n' "${probe_output}"
grep -F '"kindSandboxProbe":"passed"' <<<"${probe_output}" >/dev/null
grep -F '"issuer":"candidate-runtime"' <<<"${probe_output}" >/dev/null
grep -F '"tokenMounted":false' <<<"${probe_output}" >/dev/null
grep -F '"kubernetesApiReachable":false' <<<"${probe_output}" >/dev/null

encoded_probe="$(printf '%s' "${probe_output}" | base64 | tr -d '\n')"
gate_output="$(docker run --rm --read-only --network none "${image}" scripts/kind-authoritative-gate.mjs "${encoded_probe}")"
printf '%s\n' "${gate_output}"
grep -F '"kindAuthoritativeGate":"passed"' <<<"${gate_output}" >/dev/null
grep -F '"issuer":"coding-control-plane"' <<<"${gate_output}" >/dev/null

node scripts/kind-enterprise-failover.mjs || { diagnose; exit 1; }
node scripts/kind-coding-proof.mjs || { diagnose; exit 1; }
printf '%s\n' "Kind v2 验证通过"
