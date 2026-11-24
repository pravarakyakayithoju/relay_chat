# Kubernetes manifests

Plain YAML, no Helm, so every field is visible. They deploy the same system
as `docker-compose.yml` to a local cluster.

> **Status:** these manifests have not been applied to a real cluster yet.
> Treat them as a starting point and expect to fix small things the first
> time you run them. Docker Compose is the tested way to run the project.

## Try it on a local cluster (kind)

```bash
# 1. Build the two images (same ones Docker Compose builds)
docker compose build api nginx

# 2. Create a cluster and load the images into it
kind create cluster --name relay
kind load docker-image relay-backend:latest relay-web:latest --name relay

# 3. Deploy, in order
kubectl apply -f infra/k8s/00-namespace.yaml
kubectl apply -f infra/k8s/01-config.yaml -f infra/k8s/02-dependencies.yaml
kubectl -n relay wait --for=condition=available deploy/postgres deploy/redis deploy/redpanda --timeout=180s
kubectl apply -f infra/k8s/03-migrate-job.yaml
kubectl -n relay wait --for=condition=complete job/relay-migrate --timeout=180s
kubectl apply -f infra/k8s/04-api.yaml -f infra/k8s/05-gateway.yaml -f infra/k8s/06-workers.yaml -f infra/k8s/07-web.yaml

# 4. Open it
kubectl -n relay port-forward svc/web 8080:80
# http://localhost:8080
```

## What each file teaches

| File | Concept |
|---|---|
| `01-config.yaml` | ConfigMap vs Secret: configuration lives outside the image |
| `03-migrate-job.yaml` | A Job: run-to-completion work, separate from long-running pods |
| `04-api.yaml` | Deployment + Service + HorizontalPodAutoscaler; liveness vs readiness probes |
| `05-gateway.yaml` | Why stateful connection servers roll out one pod at a time and need a grace period |
| `06-workers.yaml` | Scaling consumers is bounded by the number of Kafka partitions |
| `07-web.yaml` | One front door for static files and reverse proxying |

Things to try once it is running:

```bash
kubectl -n relay scale deploy/api --replicas=4        # scale the stateless tier
kubectl -n relay delete pod -l app=gateway            # kill gateways; watch clients reconnect
kubectl -n relay rollout restart deploy/gateway       # rolling restart, one pod at a time
kubectl -n relay get hpa                              # autoscaler status (needs metrics-server)
```
