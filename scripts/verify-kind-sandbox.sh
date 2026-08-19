#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

cluster_name="${MN_KIND_CLUSTER_NAME:-muniu-sandbox}"
image="muniu-kind:ci"
calico_version="v3.31.6"
calico_images=(
  "quay.io/calico/cni:${calico_version}"
  "quay.io/calico/kube-controllers:${calico_version}"
  "quay.io/calico/node:${calico_version}"
)

cleanup() {
  kind delete cluster --name "${cluster_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

diagnose_calico() {
  kubectl -n kube-system get pods -l k8s-app=calico-node -o wide || true
  kubectl -n kube-system describe pods -l k8s-app=calico-node || true
  kubectl -n kube-system get events --sort-by=.lastTimestamp | tail -n 100 || true
}

docker buildx build --load --tag "${image}" .
kind create cluster --name "${cluster_name}" --config deploy/kind/config.yaml
kind load docker-image "${image}" --name "${cluster_name}"
image_digest="$(
  docker exec "${cluster_name}-control-plane" \
    ctr -n k8s.io images list |
    awk -v reference="docker.io/library/${image}" '$1 == reference { print $3 }' |
    sed 's/^sha256://'
)"
if [[ ! "${image_digest}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Could not resolve the Kind node's imported manifest digest" >&2
  exit 1
fi
for calico_image in "${calico_images[@]}"; do
  docker pull "${calico_image}"
done
kind load docker-image "${calico_images[@]}" --name "${cluster_name}"
docker exec "${cluster_name}-control-plane" mkdir -p /var/local/muniu-kind-sandboxes
docker exec "${cluster_name}-control-plane" chmod 0777 /var/local/muniu-kind-sandboxes
kubectl apply -f "https://raw.githubusercontent.com/projectcalico/calico/${calico_version}/manifests/calico.yaml"
kubectl -n kube-system rollout status daemonset/calico-node --timeout=300s || {
  diagnose_calico
  exit 1
}
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
