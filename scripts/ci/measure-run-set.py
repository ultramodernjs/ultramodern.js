#!/usr/bin/env python3
"""Measure GitHub trigger-to-last-required-check time, including runner queues.

Requires an authenticated gh CLI, not a token argument. No CI work runs locally.
Example: python3 scripts/ci/measure-run-set.py --sha HEAD_SHA --attempt 2
Use --event push for the main-branch run set, or --history 20 for Mac queues.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import subprocess


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def seconds(timestamp):
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()


def duration(start, end):
    return round(seconds(end) - seconds(start))


def jobs(repo, run, attempt=None):
    attempt = attempt or run["run_attempt"]
    result = []
    page = 1
    while True:
        batch = api(
            f"repos/{repo}/actions/runs/{run['id']}/attempts/{attempt}/jobs"
            f"?per_page=100&page={page}"
        )["jobs"]
        result.extend(batch)
        if len(batch) < 100:
            return result
        page += 1


def mac_job(job):
    return any("macos" in label.lower() for label in job["labels"])


def history(repo, count):
    runs = api(
        f"repos/{repo}/actions/workflows/ut-macOS.yml/runs?per_page={count}"
    )["workflow_runs"]
    with ThreadPoolExecutor(max_workers=4) as pool:
        batches = list(pool.map(lambda run: jobs(repo, run), runs))
    macs = [
        job for batch in batches for job in batch
        if mac_job(job) and job["conclusion"] != "skipped"
    ]
    for run, batch in reversed(list(zip(runs, batches))):
        start = run["run_started_at"]
        overlap = sum(
            job["created_at"] <= start
            and (not job["completed_at"] or job["completed_at"] >= start)
            for job in macs
        )
        rows = []
        for job in batch:
            if not mac_job(job):
                continue
            # A queued job can have started_at set to its creation time.
            # Step start is the first evidence that a runner executed it.
            steps = [step for step in job["steps"] if step["started_at"]]
            execution = steps[0]["started_at"] if steps else None
            rows.append({
                "name": job["name"],
                "queue_seconds": duration(job["created_at"], execution)
                if execution else None,
                "execution_seconds": duration(execution, job["completed_at"])
                if execution and job["completed_at"] else None,
            })
        print(json.dumps({
            "run": run["id"], "attempt": run["run_attempt"],
            "conclusion": run["conclusion"], "overlapping_earlier_macs": overlap,
            "jobs": rows,
        }))


def measure(repo, sha, event, attempt):
    runs = api(
        f"repos/{repo}/actions/runs?head_sha={sha}&event={event}&per_page=100"
    )["workflow_runs"]
    if not runs:
        raise SystemExit("No matching workflow runs")
    if attempt and any(run["run_attempt"] != attempt for run in runs):
        raise SystemExit("Attempts differ: rerun the complete set, not a subset")
    with ThreadPoolExecutor(max_workers=4) as pool:
        batches = list(pool.map(lambda run: jobs(repo, run, attempt), runs))
    start = min(run["run_started_at"] for run in runs)
    all_jobs = [job for batch in batches for job in batch]
    default = api(f"repos/{repo}")["default_branch"]
    rules = api(f"repos/{repo}/rules/branches/{default}")
    required = {
        check["context"]
        for rule in rules if rule["type"] == "required_status_checks"
        for check in rule["parameters"]["required_status_checks"]
    }
    selected = [job for job in all_jobs if job["name"] in required]
    missing = sorted(required - {job["name"] for job in selected})
    pending = [job["name"] for job in all_jobs if job["status"] != "completed"]
    failed = [
        job["name"] for job in all_jobs
        if job["conclusion"] not in ("success", "skipped", None)
    ]
    last_required = max(
        (job["completed_at"] for job in selected if job["completed_at"]),
        default=None,
    )
    complete = max(
        (job["completed_at"] for job in all_jobs if job["completed_at"]),
        default=None,
    )
    print(json.dumps({
        "sha": sha, "event": event, "attempt": attempt or "latest",
        "runs": [run["id"] for run in runs], "trigger": start,
        "required_seconds": duration(start, last_required)
        if last_required and not pending and not missing and not failed else None,
        "all_jobs_seconds": duration(start, complete)
        if complete and not pending else None,
        "last_required": [
            job["name"] for job in selected
            if job["completed_at"] == last_required
        ],
        "missing_required": missing, "pending": pending, "failed": failed,
        "mac_jobs": [{
            "name": job["name"],
            "created": job["created_at"], "started": job["started_at"],
            "completed": job["completed_at"], "conclusion": job["conclusion"],
        } for job in all_jobs if mac_job(job)],
    }, indent=2))
    if pending or failed or (event == "pull_request" and missing):
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="ultramodernjs/ultramodern.js")
    parser.add_argument("--sha")
    parser.add_argument("--event", default="pull_request", choices=["pull_request", "push"])
    parser.add_argument("--attempt", type=int)
    parser.add_argument("--history", type=int, choices=range(1, 101), metavar="1..100")
    args = parser.parse_args()
    if args.history:
        history(args.repo, args.history)
    elif args.sha:
        measure(args.repo, args.sha, args.event, args.attempt)
    else:
        parser.error("Pass --sha or --history")
