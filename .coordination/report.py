"""Portable project-coordination/v1 reporter. Requires Python 3 and authenticated gh.
Only coordination metadata is published; implementation files never leave the checkout.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from urllib.parse import quote

HUB = 'RobertsMacros/project-coordination'
VERSION = '2026-10-10.1'
CATEGORIES = {'account_access', 'decision', 'approval', 'files', 'api_token', 'physical'}

class ReportingError(RuntimeError):
    pass

def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))

def git(*args, cwd=None):
    result = subprocess.run(['git', *args], cwd=cwd, capture_output=True, timeout=10)
    if result.returncode:
        raise ReportingError('Could not read the local Git checkout')
    return result.stdout.decode().strip()

def api(endpoint, body=None, missing=False):
    args = ['gh', 'api', endpoint]
    if body is not None:
        args += ['--method', 'PUT', '--input', '-']
    result = subprocess.run(args, input=json.dumps(body).encode() if body is not None else None,
                            capture_output=True, timeout=45)
    if result.returncode:
        if missing and '(HTTP 404)' in result.stderr.decode(errors='replace'):
            return None
        raise ReportingError('GitHub did not confirm the request; do not start or duplicate work. Retry the saved event.')
    return json.loads(result.stdout)

def read(path):
    value = api(f'repos/{HUB}/contents/{path}?ref=main', missing=True)
    if value is None:
        return None, None
    if value.get('type') != 'file' or value.get('encoding') != 'base64':
        raise ReportingError('Unexpected coordination record')
    return json.loads(base64.b64decode(value['content'])), value['sha']

def put(path, value, sha=None):
    body = {'message': 'coordination: progress ' + str(value.get('event_id', value.get('task_id', 'record'))),
            'branch': 'main', 'content': base64.b64encode((json.dumps(value, indent=2, ensure_ascii=False)+'\n').encode()).decode()}
    if sha:
        body['sha'] = sha
    return api(f'repos/{HUB}/contents/{path}', body)

def key(repo, task):
    return hashlib.sha256((repo.casefold()+'\0'+task).encode()).hexdigest()

def uuid_value(value):
    if str(uuid.UUID(value)) != value:
        raise argparse.ArgumentTypeError('Use a canonical UUID')
    return value

def publish(packet):
    claim, sha = read(packet['claim_path'])
    target = packet['claim']
    # On an unknown write outcome, accept only this exact event. Never steal a
    # newer actor's claim or replace another substantive update on a retry.
    if claim != target:
        if sha != packet['expected_sha']:
            raise ReportingError('Claim changed on GitHub; this saved event cannot replace it')
        try:
            put(packet['claim_path'], target, sha)
        except (ReportingError, subprocess.TimeoutExpired):
            confirmed, _ = read(packet['claim_path'])
            if confirmed != target:
                raise ReportingError('Claim not acquired; work must wait')
    remote, _ = read(packet['event_path'])
    if remote is not None and remote != packet['event']:
        raise ReportingError('Immutable event conflict; publication stopped')
    if remote is None:
        try:
            put(packet['event_path'], packet['event'])
        except (ReportingError, subprocess.TimeoutExpired):
            remote, _ = read(packet['event_path'])
            if remote != packet['event']:
                raise ReportingError('Claim saved, event publication uncertain; retry before starting work')
    # Both records are read back, including their exact scope and actor identity.
    confirmed, _ = read(packet['claim_path'])
    event, _ = read(packet['event_path'])
    if confirmed != target or event != packet['event']:
        raise ReportingError('Read-back changed; work must wait')
    return {'published': True, 'event_id': packet['event']['event_id'],
            'task_id': target['task_id'], 'actor_id': target['actor_id'], 'active': target['active']}

def save(path, value):
    if path.is_symlink() or path.parent.is_symlink():
        raise ReportingError('Symlink reporting path refused')
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write('\n')

def report(args):
    root = Path(git('rev-parse', '--show-toplevel')).resolve()
    remote = git('remote', 'get-url', 'origin', cwd=root)
    match = re.fullmatch(r'(?:https://github.com/|git@github.com:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?', remote)
    if not match or match[1].split('/')[0].casefold() != 'robertsmacros':
        raise ReportingError('Checkout does not identify an owned GitHub repository')
    repo = match[1]
    git_dir = Path(git('rev-parse', '--absolute-git-dir', cwd=root))
    pending = git_dir / 'coordination-outbox'
    pending.mkdir(mode=0o700, exist_ok=True)
    if pending.is_symlink():
        raise ReportingError('Symlink outbox refused')
    if args.command == 'retry':
        path = pending / f'{args.event}.json'
        if path.is_symlink():
            raise ReportingError('Symlink event refused')
        packet = json.loads(path.read_text())
        if packet['event']['repository'] != repo or packet['event']['actor_id'] != args.actor:
            raise ReportingError('Retry belongs to a different checkout or actor')
        receipt = publish(packet)
        path.unlink()
        return receipt
    claim_path = f'.coordination/claims/{key(repo, args.task)}.json'
    previous, sha = read(claim_path)
    if previous and previous.get('repository') != repo:
        raise ReportingError('Claim repository mismatch')
    if previous and previous.get('active') and previous.get('actor_id') != args.actor:
        raise ReportingError('Already in progress under actor '+previous['actor_id']+'; do not duplicate it')
    if args.command == 'start':
        if previous and previous.get('active'):
            if args.title != previous['contract']['title'] or args.scope != previous['contract']['scope']:
                raise ReportingError('Active task scope differs; do not reuse this claim for different work')
            receipt = publish({'claim_path':claim_path, 'claim':previous, 'expected_sha':sha,
                'event_path':f".coordination/progress/{repo.split('/')[1]}/{previous['event']['event_id']}.json", 'event':previous['event']})
            return receipt
        if previous and not args.reopen:
            raise ReportingError('Task has an outcome already. Read it; use --reopen only for explicitly renewed scope')
        contract = {'repository':repo, 'task_id':args.task, 'title':args.title, 'scope':args.scope,
                    'criteria':args.criterion or [args.scope], 'roadmap_id':args.roadmap,
                    'milestone_ids':args.milestone or []}
        if not contract['title'] or not contract['scope']:
            raise ReportingError('Start requires the exact title and scope')
        if previous and previous['contract'] != contract:
            raise ReportingError('Reopened work must preserve its captured scope; use a new task UUID for different work')
        status = 'working'
    else:
        if not previous or not previous.get('active') or previous['actor_id'] != args.actor:
            raise ReportingError('Acquire an active start claim with this actor before reporting progress')
        contract = previous['contract']
        status = args.status
    if args.diagnostic and repo != HUB:
        raise ReportingError('Diagnostics are restricted to the coordination repository')
    user_input = None
    if args.needs_user:
        if status != 'blocked' or not args.category or not args.why:
            raise ReportingError('User input requires blocked, a category and a concrete reason')
        user_input = {'action':args.needs_user, 'category':args.category, 'why':args.why}
    event = {'schema_version':1, 'protocol':'project-coordination/v1', 'event_id':str(uuid.uuid4()),
             'actor_id':args.actor, 'task_id':args.task, 'repository':repo, 'title':contract['title'],
             'scope':contract['scope'], 'criteria':contract['criteria'], 'roadmap_id':contract['roadmap_id'],
             'milestone_ids':contract['milestone_ids'], 'status':status, 'summary':args.summary or contract['title'],
             'occurred_at':now(), 'parent_event_ids':[previous['event']['event_id']] if previous else [],
             'remaining':args.remaining or [], 'blockers':args.blocker or [], 'evidence':[], 'user_input':user_input,
             'work_ref':git('rev-parse','HEAD',cwd=root), 'work_branch':git('branch','--show-current',cwd=root),
             'implementation_published':False, 'reporter_version':VERSION,
             'diagnostic':bool(args.diagnostic or (previous and previous['event'].get('diagnostic')))}
    if args.commit:
        event['evidence'].append({'kind':'commit','ref':args.commit,'result':'Implementation revision recorded'})
    if args.report:
        event['evidence'].append({'kind':'report','ref':args.report,'result':'Exact-scope verification report; collector must check it'})
    if status == 'done' and (event['remaining'] or event['blockers']):
        raise ReportingError('Done cannot retain unfinished work or blockers')
    # A done assertion remains awaiting evidence in the dashboard. Ownership can
    # end without asserting deployment or independent completion verification.
    target = {'protocol':'project-coordination-claim/v1', 'repository':repo, 'task_id':args.task,
              'actor_id':args.actor, 'active':status in {'working','blocked'}, 'contract':contract, 'event':event}
    event_path = f".coordination/progress/{repo.split('/')[1]}/{event['event_id']}.json"
    packet = {'claim_path':claim_path,'expected_sha':sha,'claim':target,'event_path':event_path,'event':event}
    local_event = root / '.coordination/events' / f"{event['event_id']}.json"
    if (root/'.coordination').is_symlink():
        raise ReportingError('Symlink coordination folder refused')
    save(local_event, event)
    pending_path = pending / f"{event['event_id']}.json"
    save(pending_path, packet)
    os.chmod(pending_path,0o600)
    print('Saved local breadcrumb '+str(local_event), file=sys.stderr)
    receipt = publish(packet)
    pending_path.unlink()
    return receipt

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['start','update','retry'])
    parser.add_argument('--actor', required=True, type=uuid_value, help='Unique UUID for this chat/run; retain across its updates')
    parser.add_argument('--task', type=uuid_value)
    parser.add_argument('--event', type=uuid_value)
    parser.add_argument('--title'); parser.add_argument('--scope'); parser.add_argument('--summary')
    parser.add_argument('--criterion', action='append'); parser.add_argument('--roadmap'); parser.add_argument('--milestone', action='append')
    parser.add_argument('--status', choices=['working','blocked','done','cancelled'], default='working')
    parser.add_argument('--remaining',action='append'); parser.add_argument('--blocker',action='append')
    parser.add_argument('--needs-user'); parser.add_argument('--category',choices=sorted(CATEGORIES)); parser.add_argument('--why')
    parser.add_argument('--diagnostic',action='store_true',help='Exclude a coordination-repository diagnostic from dashboard tasks')
    parser.add_argument('--commit'); parser.add_argument('--report'); parser.add_argument('--reopen',action='store_true')
    args = parser.parse_args()
    if (args.command == 'retry' and not args.event) or (args.command != 'retry' and not args.task):
        parser.error('Supply --event for retry or --task for start/update')
    try:
        print(json.dumps(report(args)))
        return 0
    except (ReportingError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(str(exc),file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
