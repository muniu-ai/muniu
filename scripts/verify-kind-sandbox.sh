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
port_forward_pids=()
fixture_state_dir=""
last_port_forward_pid=""

cleanup() {
  for pid in "${port_forward_pids[@]}"; do
    kill "${pid}" >/dev/null 2>&1 || true
  done
  if [[ -n "${fixture_state_dir}" && -d "${fixture_state_dir}" ]]; then
    rm -r "${fixture_state_dir}" >/dev/null 2>&1 || true
  fi
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

diagnose_enterprise() {
  kubectl -n muniu-kind get pods,deployments,jobs,services -o wide || true
  kubectl -n muniu-kind get events --sort-by=.lastTimestamp | tail -n 150 || true
  kubectl -n muniu-kind logs deployment/muniu-api --all-pods=true --all-containers=true --tail=300 || true
  kubectl -n muniu-kind logs deployment/muniu-worker --all-pods=true --all-containers=true --tail=300 || true
  kubectl -n muniu-kind logs deployment/muniu-kind-fixture --all-pods=true --tail=200 || true
}

start_port_forward() {
  local resource="$1"
  local ports="$2"
  local log_file="$3"
  kubectl -n muniu-kind port-forward "${resource}" "${ports}" >"${log_file}" 2>&1 &
  last_port_forward_pid="$!"
  port_forward_pids+=("${last_port_forward_pid}")
}

stop_port_forward() {
  local pid="$1"
  kill "${pid}" >/dev/null 2>&1 || true
  wait "${pid}" >/dev/null 2>&1 || true
}

wait_for_http() {
  local url="$1"
  local deadline=$((SECONDS + 60))
  until curl --fail --silent --show-error "${url}" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      echo "Timed out waiting for ${url}" >&2
      return 1
    fi
    sleep 1
  done
}

wait_for_ready_replicas() {
  local deployment="$1"
  local expected="$2"
  local deadline=$((SECONDS + 180))
  local ready=""
  while (( SECONDS < deadline )); do
    ready="$(
      kubectl -n muniu-kind get deployment "${deployment}" \
        -o jsonpath='{.status.readyReplicas}'
    )"
    if [[ "${ready:-0}" == "${expected}" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for deployment/${deployment} to have ${expected} ready replicas" >&2
  return 1
}

run_failover_controller() {
  local phase="$1"
  docker run --rm --network host \
    --env MN_KIND_API_URL=http://127.0.0.1:57318 \
    --env MN_KIND_FIXTURE_URL=http://127.0.0.1:58080 \
    --env MN_KIND_POSTGRES_URL=postgresql://mn:mn-kind-only@127.0.0.1:55433/muniu \
    --env MN_KIND_FAILOVER_STATE=/state/failover.json \
    --env MN_KIND_WORKER_TOKEN_FILE=/state/worker-token \
    --volume "${fixture_state_dir}:/state" \
    "${image}" scripts/kind-enterprise-failover.mjs "${phase}"
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
configured_pids_limit="$(
  docker exec "${cluster_name}-control-plane" \
    awk '$1 == "podPidsLimit:" { print $2 }' /var/lib/kubelet/config.yaml
)"
if [[ "${configured_pids_limit}" != "256" ]]; then
  echo "Kind kubelet PID limit is ${configured_pids_limit:-unset}, expected 256" >&2
  exit 1
fi
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
dependency_images=(
  "postgres:16-alpine"
  "minio/minio:RELEASE.2025-04-22T22-12-26Z"
  "minio/mc:RELEASE.2025-04-16T18-13-26Z"
)
for dependency_image in "${dependency_images[@]}"; do
  docker pull "${dependency_image}"
done
kind load docker-image "${dependency_images[@]}" --name "${cluster_name}"
for storage_path in \
  /var/local/muniu-kind-sandboxes \
  /var/local/muniu-kind-postgres \
  /var/local/muniu-kind-minio; do
  docker exec "${cluster_name}-control-plane" mkdir -p "${storage_path}"
  docker exec "${cluster_name}-control-plane" chmod 0777 "${storage_path}"
done
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
grep -F '"pidsEnforced":true' <<<"${logs}" >/dev/null
grep -F '"kubernetesApiReachable":false' <<<"${logs}" >/dev/null
kubectl -n muniu-kind wait --for=delete pod -l muniu.ai/component=candidate-sandbox --timeout=30s
if kubectl -n muniu-kind get pods -l muniu.ai/component=candidate-sandbox -o name | grep -q .; then
  echo "Candidate Pod leaked after lease release" >&2
  exit 1
fi

kubectl apply -f deploy/kind/enterprise-fixture.yaml
kubectl -n muniu-kind rollout status deployment/muniu-kind-postgres --timeout=180s
kubectl -n muniu-kind rollout status deployment/muniu-kind-minio --timeout=180s
kubectl -n muniu-kind rollout status deployment/muniu-kind-fixture --timeout=180s
kubectl -n muniu-kind wait --for=condition=Complete job/muniu-kind-minio-init --timeout=180s
kubectl -n muniu-kind wait --for=condition=Complete job/muniu-kind-source-seed --timeout=180s

helm upgrade --install muniu deploy/helm/muniu \
  --namespace muniu-kind \
  --values deploy/helm/muniu/values-kind.yaml \
  --set-string "sandbox.imageDigest=${image_digest}" \
  --wait \
  --timeout 5m || {
    diagnose_enterprise
    exit 1
  }
kubectl -n muniu-kind rollout status deployment/muniu-api --timeout=180s

fixture_state_dir="$(mktemp -d)"
chmod 0777 "${fixture_state_dir}"
start_port_forward service/muniu 57318:80 "${fixture_state_dir}/api-port-forward.log"
api_port_forward_pid="${last_port_forward_pid}"
start_port_forward service/muniu-kind-fixture 58080:8080 "${fixture_state_dir}/fixture-port-forward.log"
start_port_forward service/muniu-kind-postgres 55433:5432 "${fixture_state_dir}/postgres-port-forward.log"
wait_for_http http://127.0.0.1:57318/healthz
wait_for_http http://127.0.0.1:58080/health

run_failover_controller bootstrap
docker run --rm --network none --user 0 \
  --entrypoint /bin/chown \
  --volume "${fixture_state_dir}:/state" \
  "${image}" "$(id -u):$(id -g)" /state/worker-token
kubectl -n muniu-kind create secret generic muniu-worker-auth \
  --from-file="token=${fixture_state_dir}/worker-token" \
  --dry-run=client \
  --output=yaml | kubectl apply -f -
helm upgrade muniu deploy/helm/muniu \
  --namespace muniu-kind \
  --values deploy/helm/muniu/values-kind.yaml \
  --set api.replicas=2 \
  --set worker.enabled=true \
  --set-string "sandbox.imageDigest=${image_digest}" \
  --wait \
  --timeout 5m || {
    diagnose_enterprise
    exit 1
  }
kubectl -n muniu-kind rollout status deployment/muniu-api --timeout=180s
kubectl -n muniu-kind rollout status deployment/muniu-worker --timeout=180s

owner_capture="$(run_failover_controller capture)" || {
  diagnose_enterprise
  exit 1
}
printf '%s\n' "${owner_capture}"
owner_pod="$(sed -n 's/.*"ownerPod":"\([^"]*\)".*/\1/p' <<<"${owner_capture}")"
if [[ ! "${owner_pod}" =~ ^muniu-api-[a-z0-9-]+$ ]]; then
  echo "Could not resolve the durable builtin owner Pod" >&2
  diagnose_enterprise
  exit 1
fi
kubectl -n muniu-kind delete pod "${owner_pod}" --wait=false
kubectl -n muniu-kind wait --for=delete "pod/${owner_pod}" --timeout=180s
kubectl -n muniu-kind rollout status deployment/muniu-api --timeout=180s
wait_for_ready_replicas muniu-api 2
stop_port_forward "${api_port_forward_pid}"
start_port_forward service/muniu 57318:80 "${fixture_state_dir}/api-port-forward-after-owner-loss.log"
api_port_forward_pid="${last_port_forward_pid}"
wait_for_http http://127.0.0.1:57318/healthz
run_failover_controller verify || {
  diagnose_enterprise
  exit 1
}

postgres_pod="$(kubectl -n muniu-kind get pod -l app=muniu-kind-postgres -o jsonpath='{.items[0].metadata.name}')"
kubectl -n muniu-kind delete pod "${postgres_pod}" --wait=false
kubectl -n muniu-kind rollout status deployment/muniu-kind-postgres --timeout=180s
run_failover_controller post-restart || {
  diagnose_enterprise
  exit 1
}

kubectl -n muniu-kind wait --for=delete pod -l muniu.ai/component=candidate-sandbox --timeout=60s
if kubectl -n muniu-kind get pods -l muniu.ai/component=candidate-sandbox -o name | grep -q .; then
  echo "Candidate Pod leaked after enterprise failover run" >&2
  exit 1
fi
echo '{"kindEnterpriseSuite":"passed"}'
