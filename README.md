# Render Race

Benchmark de rendu distribué : un coordinateur découpe une image en tuiles, des
workers (Rust, puis Go et JS) les calculent sur plusieurs machines, et le
navigateur affiche chaque tuile à son arrivée, colorée selon la machine qui l'a
rendue.

## Architecture

- `coordinator/` (Go) : file de tuiles, long-poll HTTP pour les workers,
  WebSocket vers le navigateur, interface web embarquée.
- `workers/rust/` : un thread par cœur, chacun tire une tuile, la calcule, renvoie le résultat.

Les workers **tirent** le travail : les machines rapides prennent naturellement
plus de tuiles. Une tuile non rendue en 10 s retourne dans la file, donc un
worker qui meurt en plein rendu ne bloque rien.

## Protocole worker

- `GET /api/worker/next` avec `X-Worker-Id`, `X-Worker-Machine`, `X-Worker-Lang`,
  `X-Worker-Threads` → `200` + tuile JSON, ou `204` après 15 s sans travail.
- `POST /api/worker/result?job=&tile=` avec `X-Worker-Id`, `X-Compute-Ns`, corps =
  un `u32` little-endian par pixel (itérations), ligne par ligne → `204`, ou `410`
  si le job a été remplacé.

## Lancer

```
cd coordinator && go run .                       # http://localhost:8080
cd workers/rust && cargo run --release -- --coordinator http://localhost:8080 --machine macbook
```
