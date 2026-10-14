# Render Race

Benchmark de rendu distribué : un coordinateur découpe une image en tuiles, des
workers (Rust, puis Go et JS) les calculent sur plusieurs machines, et le
navigateur affiche chaque tuile à son arrivée, colorée selon la machine qui l'a
rendue.

## Architecture

- `coordinator/` (Go) : file de tuiles, long-poll HTTP pour les workers,
  WebSocket vers le navigateur, interface web embarquée.
- `workers/cuda/` : Python + CuPy, kernels CUDA compilés à la volée (NVRTC).
- `workers/{rust,go,js}/` : même algorithme dans les trois langages. Un thread
  (goroutine, worker_thread) par cœur, chacun tire une tuile, la calcule, renvoie le résultat.

Une **course** rend la même image une fois par couloir (par machine, par langage,
par worker, ou un seul couloir avec tout le monde). Le coordinateur hache chaque
tuile et compare les couloirs : les trois langages doivent produire exactement
les mêmes octets.

## Pièges de reproductibilité rencontrés

- **serde_json** parse les flottants avec un chemin rapide qui peut être faux
  d'1 ULP : en zoom profond, ça décale des pixels. Feature `float_roundtrip`.
- **Go** peut fusionner `a*b+c` en une instruction FMA (arrondi unique) sur arm64.
  Les conversions explicites `float64(...)` l'en empêchent (préventif, d'après la spec).
- **CUDA** fusionne `a*b+c` par défaut : kernels compilés avec `--fmad=false`.
- Le path tracer n'utilise que `+ - * /` et `sqrt` (arrondis exacts IEEE 754), un
  RNG entier 32 bits, et un ordre d'opérations figé : Rust, Go, JS et le GPU
  produisent les mêmes octets. La caméra (qui a besoin de `tan`) est calculée par
  le coordinateur.

## Perf : ce qu'on a appris

- **Go, vecteurs en `[3]float64`** : 5× plus lent que Rust. L'ABI registre de Go
  passe les petites structs dans les registres mais pas les tableaux. Passage à
  `struct{X, Y, Z}` : 155 → 70 ms/tuile, puis pointeur vers la sphère au lieu de
  scène + index : 61 ms (Rust : 31 ms).
- **GPU** : en tuiles de 64 px, un kernel n'a que 4096 pixels, le 4090 attend le
  réseau et perd contre Rust. En 256 px, il gagne (×1,7). En `f64` (requis pour
  être identique aux CPU), le 4090 tourne à 1/64 de sa vitesse `f32`.
- Courses sur une même machine : `--sequential`, sinon les couloirs se partagent
  les cœurs.

Les workers **tirent** le travail : les machines rapides prennent naturellement
plus de tuiles. Une tuile non rendue en 10 s retourne dans la file, donc un
worker qui meurt en plein rendu ne bloque rien.

## Protocole worker

- `GET /api/worker/next` avec `X-Worker-Id`, `X-Worker-Machine`, `X-Worker-Lang`,
  `X-Worker-Threads` → `200` + tuile JSON, ou `204` après 15 s sans travail.
- `POST /api/worker/result?job=&tile=` avec `X-Worker-Id`, `X-Compute-Ns`, corps =
  un `u32` little-endian par pixel (itérations), ligne par ligne → `204`, ou `410`
  si le job a été remplacé.

## Lancer en local

```
cd coordinator && go run .                       # http://localhost:8080
cd workers/rust && cargo run --release -- --coordinator http://localhost:8080 --machine macbook
```

## Flotte (Tailscale)

| Machine | Rôle | Services |
|---|---|---|
| mini | coordinateur (IP Tailscale, port 8787) + workers | launchd `dev.render-race.*` |
| vps | workers, `Nice=19` pour laisser la priorité aux sites | systemd `render-race-*` |
| pc | workers dans WSL | systemd `render-race-*`, WSL gardé allumé |
| macbook | workers à la demande | `scripts/fleet.sh macbook start` |

La config de la flotte (IP Tailscale du coordinateur, adresses MAC pour le
Wake-on-LAN) est dans `fleet.env`, non versionné : copier `fleet.env.example`.

```
scripts/build.sh      # cross-compile tout (Go natif, Rust via cargo-zigbuild)
scripts/deploy.sh     # build + envoi + (re)démarrage des services
scripts/fleet.sh status
RENDER_RACE_COORDINATOR=http://mini:8787 node scripts/race.mjs --by machine --lang rust
```

Interface : `http://<coordinateur>:8787`
