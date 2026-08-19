#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

cluster_name="${MN_KIND_CLUSTER_NAME:-muniu-sandbox}"
image="muniu-kind:ci"
registry_name="${cluster_name}-registry"
registry_port="${MN_KIND_REGISTRY_PORT:-5001}"
registry_repository="localhost:${registry_port}/muniu-kind"
registry_image="${registry_repository}:ci"
calico_version="v3.31.6"
calico_images=(
  "quay.io/calico/cni:${calico_version}"
  "quay.io/calico/kube-controllers:${calico_version}"
  "quay.io/calico/node:${calico_version}"
)
cluster_created=false
registry_created=false

cleanup() {
  if [[ "${cluster_created}" == "true" ]]; then
    kind delete cluster --name "${cluster_name}" >/dev/null 2>&1 || true
  fi
  if [[ "${registry_created}" == "true" ]]; then
    docker rm --force "${registry_name}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

diagnose_calico() {
  kubectl -n kube-system get pods -l k8s-app=calico-node -o wide || true
  kubectl -n kube-system describe pods -l k8s-app=calico-node || true
  kubectl -n kube-system get events --sort-by=.lastTimestamp | tail -n 100 || true
}

diagnose_probe() {
  kubectl -n muniu-kind describe job/muniu-sandbox-probe || true
  kubectl -n muniu-kind logs job/muniu-sandbox-probe --all-containers=true || true
  kubectl -n muniu-kind get pods -o yaml || true
}

wait_for_probe_job() {
  local deadline=$((SECONDS + 300))
  local conditions
  local failed
  while (( SECONDS < deadline )); do
    conditions="$(
      kubectl -n muniu-kind get job/muniu-sandbox-probe \
        -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"\n"}{end}'
    )"
    if grep -Eq '^Complete=True$' <<<"${conditions}"; then
      return 0
    fi
    failed="$(
      kubectl -n muniu-kind get job/muniu-sandbox-probe \
        -o jsonpath='{.status.failed}'
    )"
    if grep -Eq '^(Failed|FailureTarget)=True$' <<<"${conditions}" || [[ "${failed:-0}" -gt 0 ]]; then
      echo "Kind sandbox probe Job failed" >&2
      return 1
    fi
    sleep 1
  done
  echo "Timed out waiting for the Kind sandbox probe Job" >&2
  return 1
}

if kind get clusters | grep -Fxq "${cluster_name}"; then
  echo "Kind cluster ${cluster_name} already exists; refusing to replace it" >&2
  exit 1
fi
if docker inspect "${registry_name}" >/dev/null 2>&1; then
  echo "Docker container ${registry_name} already exists; refusing to replace it" >&2
  exit 1
fi

docker buildx build --load --tag "${image}" .
docker run \
  --detach \
  --publish "127.0.0.1:${registry_port}:5000" \
  --network bridge \
  --name "${registry_name}" \
  registry:3
registry_created=true
kind create cluster --name "${cluster_name}" --config deploy/kind/config.yaml
cluster_created=true
registry_directory="/etc/containerd/certs.d/localhost:${registry_port}"
for node in $(kind get nodes --name "${cluster_name}"); do
  docker exec "${node}" mkdir -p "${registry_directory}"
  docker exec -i "${node}" cp /dev/stdin "${registry_directory}/hosts.toml" <<EOF
[host."http://${registry_name}:5000"]
EOF
done
docker network connect kind "${registry_name}"
kind load docker-image "${image}" --name "${cluster_name}"
docker tag "${image}" "${registry_image}"
docker push "${registry_image}"
pushed_image="$(
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${registry_image}" |
    awk -v repository="${registry_repository}@" 'index($0, repository) == 1 { print; exit }'
)"
image_digest="${pushed_image##*@sha256:}"
if [[ ! "${image_digest}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Could not resolve the local registry manifest digest" >&2
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
kubectl -n muniu-kind create configmap muniu-kind-image \
  --from-literal="digest=${image_digest}" \
  --from-literal="reference=${registry_image}"
kubectl apply -f deploy/kind/sandbox-probe.yaml
wait_for_probe_job || {
  diagnose_probe
  exit 1
}
logs="$(kubectl -n muniu-kind logs job/muniu-sandbox-probe)"
printf '%s\n' "${logs}"
grep -F '"kindSandboxProbe":"passed"' <<<"${logs}" >/dev/null
grep -F '"tokenMounted":false' <<<"${logs}" >/dev/null
grep -F '"pidsLimit":256' <<<"${logs}" >/dev/null
grep -F '"kubernetesApiReachable":false' <<<"${logs}" >/dev/null
kubectl -n muniu-kind wait --for=delete pod -l muniu.ai/component=candidate-sandbox --timeout=30s
if kubectl -n muniu-kind get pods -l muniu.ai/component=candidate-sandbox -o name | grep -q .; then
  echo "Candidate Pod leaked after lease release" >&2
  exit 1
fi
