#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

cluster_name="${MN_KIND_CLUSTER_NAME:-muniu-sandbox}"
image="muniu-kind:ci"
calico_version="v3.29.3"
metadata_file="${RUNNER_TEMP:-/tmp}/muniu-kind-image-metadata.json"

cleanup() {
  kind delete cluster --name "${cluster_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker buildx build --load --tag "${image}" --metadata-file "${metadata_file}" .
image_digest="$(jq -r '.["containerimage.digest"] // empty' "${metadata_file}" | sed 's/^sha256://')"
if [[ ! "${image_digest}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Could not resolve the Kind probe image digest" >&2
  exit 1
fi

kind create cluster --name "${cluster_name}" --config deploy/kind/config.yaml
kind load docker-image "${image}" --name "${cluster_name}"
docker exec "${cluster_name}-control-plane" mkdir -p /var/local/muniu-kind-sandboxes
docker exec "${cluster_name}-control-plane" chmod 0777 /var/local/muniu-kind-sandboxes
kubectl apply -f "https://raw.githubusercontent.com/projectcalico/calico/${calico_version}/manifests/calico.yaml"
kubectl -n kube-system rollout status daemonset/calico-node --timeout=300s
kubectl -n kube-system rollout status deployment/calico-kube-controllers --timeout=300s
kubectl wait --for=condition=Ready node --all --timeout=300s
kubectl create namespace muniu-kind
kubectl -n muniu-kind create configmap muniu-kind-image --from-literal="digest=${image_digest}"
kubectl apply -f deploy/kind/sandbox-probe.yaml
kubectl -n muniu-kind wait --for=condition=Complete job/muniu-sandbox-probe --timeout=300s || {
  kubectl -n muniu-kind describe job/muniu-sandbox-probe
  kubectl -n muniu-kind logs job/muniu-sandbox-probe --all-containers=true || true
  kubectl -n muniu-kind get pods -o yaml
  exit 1
}
logs="$(kubectl -n muniu-kind logs job/muniu-sandbox-probe)"
printf '%s\n' "${logs}"
grep -F '"kindSandboxProbe":"passed"' <<<"${logs}" >/dev/null
grep -F '"tokenMounted":false' <<<"${logs}" >/dev/null
grep -F '"kubernetesApiReachable":false' <<<"${logs}" >/dev/null
kubectl -n muniu-kind wait --for=delete pod -l muniu.ai/component=candidate-sandbox --timeout=30s
if kubectl -n muniu-kind get pods -l muniu.ai/component=candidate-sandbox -o name | grep -q .; then
  echo "Candidate Pod leaked after lease release" >&2
  exit 1
fi
