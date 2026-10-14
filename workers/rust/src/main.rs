//! Rust worker: one thread per core, each one pulls a tile from the
//! coordinator, renders it and posts the result back.

mod pathtrace;

use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tile {
    job_id: u32,
    tile_id: u32,
    kind: String,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    width: u32,
    height: u32,
    params: Option<MandelbrotParams>,
    scene: Option<pathtrace::Scene>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MandelbrotParams {
    center_x: f64,
    center_y: f64,
    scale: f64,
    max_iter: u32,
}

#[derive(Clone)]
struct Config {
    coordinator: String,
    id: String,
    machine: String,
    threads: usize,
}

fn main() {
    let config = parse_args();
    println!(
        "worker {} -> {} with {} threads",
        config.id, config.coordinator, config.threads
    );

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        // Longer than the coordinator's long-poll so an idle poll isn't an error.
        .timeout_read(Duration::from_secs(30))
        .build();

    let handles: Vec<_> = (0..config.threads)
        .map(|_| {
            let (agent, config) = (agent.clone(), config.clone());
            thread::spawn(move || work_loop(&agent, &config))
        })
        .collect();
    for h in handles {
        let _ = h.join();
    }
}

fn work_loop(agent: &ureq::Agent, config: &Config) {
    loop {
        let tile = match next_tile(agent, config) {
            Ok(Some(tile)) => tile,
            Ok(None) => continue, // poll timed out with no work
            Err(err) => {
                eprintln!("coordinator unreachable: {err}");
                thread::sleep(Duration::from_secs(2));
                continue;
            }
        };
        let started = Instant::now();
        let pixels = match (tile.kind.as_str(), &tile.params, &tile.scene) {
            ("mandelbrot", Some(params), _) => render_mandelbrot(&tile, params),
            ("pathtrace", _, Some(scene)) => {
                pathtrace::render(scene, tile.x, tile.y, tile.w, tile.h, tile.width, tile.height)
            }
            _ => {
                eprintln!("unsupported tile kind {}", tile.kind);
                continue;
            }
        };
        let compute_ns = started.elapsed().as_nanos();

        let url = format!(
            "{}/api/worker/result?job={}&tile={}",
            config.coordinator, tile.job_id, tile.tile_id
        );
        // A network blip must not cost the tile: retry before giving up (the
        // coordinator would only hand it out again after its timeout).
        for attempt in 1..=3 {
            match agent
                .post(&url)
                .set("X-Worker-Id", &config.id)
                .set("X-Compute-Ns", &compute_ns.to_string())
                .send_bytes(&pixels)
            {
                Ok(_) | Err(ureq::Error::Status(410, _)) => break, // 410: job replaced meanwhile
                Err(ureq::Error::Status(code, _)) => {
                    eprintln!("tile {} rejected: {code}", tile.tile_id);
                    break;
                }
                Err(err) => {
                    eprintln!("failed to send tile {} (attempt {attempt}): {err}", tile.tile_id);
                    thread::sleep(Duration::from_secs(1));
                }
            }
        }
    }
}

fn next_tile(agent: &ureq::Agent, config: &Config) -> Result<Option<Tile>, ureq::Error> {
    let res = agent
        .get(&format!("{}/api/worker/next", config.coordinator))
        .set("X-Worker-Id", &config.id)
        .set("X-Worker-Machine", &config.machine)
        .set("X-Worker-Lang", "rust")
        .set("X-Worker-Threads", &config.threads.to_string())
        .call()?;
    if res.status() == 204 {
        return Ok(None);
    }
    Ok(Some(res.into_json()?))
}

/// One little-endian u32 escape iteration count per pixel, row by row.
fn render_mandelbrot(t: &Tile, p: &MandelbrotParams) -> Vec<u8> {
    let (half_w, half_h) = (t.width as f64 / 2.0, t.height as f64 / 2.0);
    let mut out = Vec::with_capacity((t.w * t.h * 4) as usize);
    for py in t.y..t.y + t.h {
        let cy = p.center_y + (py as f64 + 0.5 - half_h) * p.scale;
        for px in t.x..t.x + t.w {
            let cx = p.center_x + (px as f64 + 0.5 - half_w) * p.scale;
            out.extend_from_slice(&escape_time(cx, cy, p.max_iter).to_le_bytes());
        }
    }
    out
}

fn escape_time(cx: f64, cy: f64, max_iter: u32) -> u32 {
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let mut i = 0;
    while i < max_iter {
        let (x2, y2) = (x * x, y * y);
        if x2 + y2 > 4.0 {
            break;
        }
        y = 2.0 * x * y + cy;
        x = x2 - y2 + cx;
        i += 1;
    }
    i
}

fn parse_args() -> Config {
    let mut coordinator = "http://localhost:8080".to_string();
    let mut machine = hostname();
    let mut threads = thread::available_parallelism().map_or(1, |n| n.get());

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().expect("missing value after flag");
        match arg.as_str() {
            "--coordinator" => coordinator = value().trim_end_matches('/').to_string(),
            "--machine" => machine = value(),
            "--threads" => threads = value().parse().expect("--threads must be a number"),
            _ => panic!("unknown flag {arg} (expected --coordinator, --machine, --threads)"),
        }
    }
    Config {
        id: format!("{machine}-rust"),
        coordinator,
        machine,
        threads,
    }
}

fn hostname() -> String {
    Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().split('.').next().unwrap_or("").to_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}
