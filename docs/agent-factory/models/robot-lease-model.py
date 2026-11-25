#!/usr/bin/env python3
"""Exhaustive model of the robotics tables in docs/agent-factory/robotics.md (stdlib only, no network).

Part 1 models Table 1 (motion authority): two leases, one robot, message delay / duplication / reordering / loss,
restart with and without memory, bounded discrete time. Part 2 models Table 2 (record life) as a creation-order
search. Every old rule is a switch; each switch must be caught by the invariant named next to it.

Usage: python -I robot-lease-model.py [part1|part2|all] [switch ...]
"""
import sys
import time
from collections import namedtuple, deque

# ----------------------------------------------------------------------------------------------------------------------
# Part 1: Table 1, motion authority
# ----------------------------------------------------------------------------------------------------------------------
H = 2          # robotics.heartbeatSeconds: maximum authority term, in ticks
TOL = 1        # tolerance added to the server bound (clock rate difference, scheduling), in ticks
E = 5          # lease and package expiry term, in ticks (longer than H + TOL, so expiry cannot mask a late answer)
T_EV = 2       # new activity (challenge, command, restart, fault ...) only up to this tick
T_ISS = 4      # a lease is issued only up to this tick
TMAX = T_ISS + E + TOL + 1   # time runs on until every bound has passed, so settling events can finish
C = 2          # challenges (or old-style heartbeats) per boot / lease
NCMD = 0       # commands per lease (set by the profile)
NISSUE = 2     # leases issued in one run (set by the profile)
# budgets of faults and operator actions: loss, duplication, restart with memory, restart without memory,
# quarantine, local safe stop, end requested. At most FAULT_CAP of the first six happen in one run.
BUDGET = (1, 1, 1, 1, 1, 1, 1)
FAULT_CAP = 2
MAXSTATES = 2500000
LOSS, DUP, RM, RN, QN, SS, ER = range(7)


def can(s, k):
    used = sum(BUDGET[:6]) - sum(s.bud[:6])
    return s.bud[k] > 0 and used < FAULT_CAP

STOPPED, IDLE, ARMED = 0, 1, 2
ACTIVE, ENDING, ENDED = 1, 2, 3

S = namedtuple('S', 't srv cmd P SCHK U Q SRE lbn ep R CHK RE pkg pexp auth bn ctr iss lacc queue hi memhi net execs flags bud')


def add(net, m):
    """The network is a set: two identical copies in flight are indistinguishable from one, so duplication is
    modelled as 'delivered and a copy stays in flight' (see succ)."""
    if m in net:
        return net
    return tuple(sorted(net + (m,)))


def rem(net, m):
    l = list(net)
    l.remove(m)
    return tuple(l)


def setsrv(s, i, lease):
    srv = list(s.srv)
    srv[i] = lease
    return tuple(srv)


def live(s):
    return s.R == ARMED and s.pkg >= 0 and s.t < s.auth


def initial():
    return S(t=0, srv=((0, -1, 0, 0, 0), (0, -1, 0, 0, 0)), cmd=(0,) * (2 * NCMD), P=1, SCHK=1, U=0, Q=0, SRE=0,
             lbn=0, ep=0, R=IDLE, CHK=1, RE=0, pkg=-1, pexp=0, auth=-1, bn=1, ctr=0, iss=(-1,) * C, lacc=0, queue=(),
             hi=(0, 0), memhi=0, net=(), execs=(0,) * (2 * NCMD), flags=(), bud=BUDGET)


def incident(s):
    """Platform leaves free: needs a fresh diagnostic of the new epoch and a release."""
    if s.P == 0 and s.SCHK == 0:
        return s
    return s._replace(P=0, SCHK=0, ep=min(s.ep + 1, 4))


def finish(s, j):
    """Lease j becomes ended (end confirmed, or the bound passed)."""
    st, A, exp, ln, hs = s.srv[j]
    if st == ENDED:
        return s
    cmd = list(s.cmd)
    unreported = False
    for k in range(NCMD):
        c = cmd[j * NCMD + k]
        if c == 2:
            unreported = True
        if c == 1:
            cmd[j * NCMD + k] = 3
    s = s._replace(srv=setsrv(s, j, (ENDED, A, exp, ln, hs)), cmd=tuple(cmd))
    if unreported:
        s = incident(s._replace(U=1))
    return s


def end_req(s, i):
    st, A, exp, ln, hs = s.srv[i]
    cmd = list(s.cmd)
    for k in range(NCMD):
        if cmd[i * NCMD + k] == 1:
            cmd[i * NCMD + k] = 3
    return s._replace(srv=setsrv(s, i, (ENDING, A, exp, ln, hs)), cmd=tuple(cmd), net=add(s.net, ('lend', i, 0, 0)))


def apply_report(s, h):
    """A robot report 'highest accepted lease number h, no package held': leases numbered <= h are ended."""
    for j in (0, 1):
        if j + 1 <= h and s.srv[j][0] in (ACTIVE, ENDING):
            s = finish(s, j)
    return s


def deliver(s, m, M):
    kind, a, b, c = m
    t = s.t
    s = s._replace(net=rem(s.net, m))
    if kind == 'pkg':
        i, exp = a, b
        if s.R in (IDLE, ARMED) and i + 1 > s.memhi and t < exp:
            hi = list(s.hi)
            hi[i] = 0
            return s._replace(pkg=i, pexp=exp, auth=-1, memhi=i + 1, R=ARMED, queue=(), lacc=0, hi=tuple(hi))
        return s
    if kind == 'chal':
        i, bn, n = a, b, c
        st, A, exp, ln, hs = s.srv[i]
        key = bn * 10 + n
        if st == ACTIVE and key > ln:
            s = s._replace(srv=setsrv(s, i, (st, t, exp, key, hs)))
            return s._replace(net=add(s.net, ('ans', i, bn, n)))
        return s
    if kind == 'ans':
        i, bn, n = a, b, c
        if (s.R == ARMED and s.pkg == i and bn == s.bn and 1 <= n <= s.ctr and n > s.lacc
                and t - s.iss[n - 1] < H and t < s.pexp):
            return s._replace(auth=max(s.auth, min(s.iss[n - 1] + H, s.pexp)), lacc=n)
        return s
    if kind == 'hb':      # old rule: the server's rising sequence, aged from receipt
        i, seq = a, b
        if s.R == ARMED and s.pkg == i and seq > s.lacc and t < s.pexp:
            return s._replace(auth=max(s.auth, min(t + H, s.pexp)), lacc=seq)
        return s
    if kind == 'cmd':
        i, seq = a, b
        if s.R == ARMED and s.pkg == i and t < s.pexp and (M.get('no_seq_check') or seq > s.hi[i]):
            ent = (i, seq, s.bn)
            if ent not in s.queue:
                return s._replace(queue=tuple(sorted(s.queue + (ent,))))
        return s
    if kind == 'rpt':
        idx = a * NCMD + b - 1
        if s.cmd[idx] == 2:
            cmd = list(s.cmd)
            cmd[idx] = 4
            return s._replace(cmd=tuple(cmd))
        return s
    if kind == 'lend':
        if s.pkg == a:
            return s._replace(pkg=-1, auth=-1, queue=(), R=IDLE, net=add(s.net, ('rep', s.memhi, 0, 0)))
        return s
    if kind == 'rep':
        h, boot, lost = a, b, c
        s = apply_report(s, h)
        if boot:
            s = incident(s)
        if lost and lost > s.lbn:       # a memory-loss report is handled once per boot: a re-enrol covers older ones
            s = incident(s._replace(SRE=1, lbn=lost))
        return s
    if kind == 'dres':
        h, ep = a, b
        s = apply_report(s, h)
        if ep == s.ep:
            s = s._replace(SCHK=1, U=0)
        return s
    raise AssertionError(kind)


def succ(s, M):
    out = []
    t = s.t
    ev = t <= T_EV          # faults, restarts, quarantine, end requests happen only early
    evb = t <= T_ISS        # issue, challenges and new commands happen over the whole issue window
    if t < TMAX:
        out.append(('tick', s._replace(t=t + 1), 'help'))
    nissued = sum(1 for l in s.srv if l[0] != 0)
    open_ok = all(l[0] in (0, ENDED) for l in s.srv)
    if M.get('issue_while_ending'):
        open_ok = all(l[0] in (0, ENDING, ENDED) for l in s.srv)
    if evb and nissued < NISSUE and open_ok and s.P == 1 and not s.U and not s.Q and not s.SRE:
        i = nissued
        out.append(('issue L%d' % i, s._replace(srv=setsrv(s, i, (ACTIVE, -1, t + E, 0, 0)),
                                               net=add(s.net, ('pkg', i, t + E, 0))), 'env'))
    for i in (0, 1):
        st, A, exp, ln, hs = s.srv[i]
        if st == ACTIVE:
            if evb:
                for k in range(NCMD):
                    if s.cmd[i * NCMD + k] == 0 and (k == 0 or s.cmd[i * NCMD + k - 1] != 0):
                        cmd = list(s.cmd)
                        cmd[i * NCMD + k] = 1
                        out.append(('create command L%d#%d' % (i, k + 1), s._replace(cmd=tuple(cmd)), 'env'))
                        break
            for k in range(NCMD):
                if s.cmd[i * NCMD + k] == 1 and (k == 0 or s.cmd[i * NCMD + k - 1] != 1):
                    cmd = list(s.cmd)
                    cmd[i * NCMD + k] = 2
                    out.append(('fetch command L%d#%d' % (i, k + 1),
                                s._replace(cmd=tuple(cmd), net=add(s.net, ('cmd', i, k + 1, 0))), 'help'))
                    break
            if M.get('old_hb') and evb and hs < C:
                s2 = s._replace(srv=setsrv(s, i, (st, t, exp, ln, hs + 1)), net=add(s.net, ('hb', i, hs + 1, 0)))
                out.append(('server sends heartbeat %d of L%d' % (hs + 1, i), s2, 'env'))
            if s.bud[ER] > 0:
                bud = list(s.bud)
                bud[ER] -= 1
                out.append(('end requested L%d' % i, end_req(s, i)._replace(bud=tuple(bud)), 'env'))
            if t >= exp:
                out.append(('lease L%d expires' % i, s._replace(srv=setsrv(s, i, (ENDING, A, exp, ln, hs))), 'help'))
        if st == ENDING:
            bound = -1 if A < 0 else min(A + H, exp) + TOL
            if t >= bound:
                out.append(('bound passed L%d' % i, finish(s, i), 'help'))
    # robot: challenge (new rule)
    if (not M.get('old_hb')) and evb and s.R == ARMED and s.pkg >= 0 and s.ctr < C:
        n = s.ctr + 1
        iss = list(s.iss)
        iss[n - 1] = t
        out.append(('robot issues challenge %d' % n,
                    s._replace(ctr=n, iss=tuple(iss), net=add(s.net, ('chal', s.pkg, s.bn, n))), 'env'))
    # messages
    for m in sorted(set(s.net)):
        out.append(('deliver %s' % (m,), deliver(s, m, M), 'help'))
        if can(s, LOSS):
            bud = list(s.bud)
            bud[LOSS] -= 1
            out.append(('lose %s' % (m,), s._replace(net=rem(s.net, m), bud=tuple(bud)), 'env'))
        if can(s, DUP):
            bud = list(s.bud)
            bud[DUP] -= 1
            s2 = deliver(s, m, M)
            out.append(('deliver %s and keep a copy in flight (duplicate)' % (m,),
                        s2._replace(net=add(s2.net, m), bud=tuple(bud)), 'env'))
    # robot: execute
    if live(s):
        for ent in s.queue:
            i, seq, b = ent
            if i == s.pkg and (M.get('no_seq_check') or seq > s.hi[i]):
                flags = set(s.flags)
                if s.srv[i][0] == ENDED:
                    flags.add('I2 command executed after its lease ended')
                if b != s.bn:
                    flags.add('I4 command of an earlier boot executed')
                if s.CHK == 0:
                    flags.add('I4 motion in a boot without a recorded self check')
                execs = list(s.execs)
                execs[i * NCMD + seq - 1] += 1
                hi = list(s.hi)
                hi[i] = max(hi[i], seq)
                q = tuple(x for x in s.queue if x != ent)
                out.append(('execute L%d#%d' % (i, seq),
                            s._replace(queue=q, hi=tuple(hi), execs=tuple(execs), flags=tuple(sorted(flags)),
                                       net=add(s.net, ('rpt', i, seq, 0))), 'help'))
    # robot: drop the package when authority lapsed (link loss beyond the limit, expiry)
    if s.R == ARMED and not live(s):
        out.append(('robot drops package (authority lapsed)',
                    s._replace(pkg=-1, auth=-1, queue=(), R=IDLE, net=add(s.net, ('rep', s.memhi, 0, 0))), 'help'))
    # robot: local safe stop (interlock open, fault, link loss beyond the limit while moving)
    if s.R == ARMED and can(s, SS) and ev:
        bud = list(s.bud)
        bud[SS] -= 1
        out.append(('robot safe stop', s._replace(pkg=-1, auth=-1, queue=(), R=STOPPED, CHK=0, bud=tuple(bud),
                                                  net=add(s.net, ('rep', s.memhi, 1, 0))), 'env'))
    # robot restarts
    if ev and can(s, RM):
        bud = list(s.bud)
        bud[RM] -= 1
        base = s._replace(auth=-1, bn=s.bn + 1, ctr=0, iss=(-1,) * C, lacc=0, CHK=0, bud=tuple(bud),
                          net=add(s.net, ('rep', s.memhi, 1, 0)))
        if M.get('restore_workflow'):
            s2 = base                      # package and queue restored: the old workflow continues
        elif M.get('lenient_restart'):
            s2 = base._replace(pkg=-1, queue=(), R=IDLE)      # memory intact: only a new lease is needed
        else:
            s2 = base._replace(pkg=-1, queue=(), R=STOPPED)
        out.append(('robot restarts, memory intact', s2, 'env'))
    if ev and can(s, RN):
        bud = list(s.bud)
        bud[RN] -= 1
        s2 = s._replace(pkg=-1, auth=-1, queue=(), R=STOPPED, bn=s.bn + 1, ctr=0, iss=(-1,) * C, lacc=0, CHK=0,
                        RE=1, memhi=0, hi=(0, 0), bud=tuple(bud), net=add(s.net, ('rep', 0, 1, s.bn + 1)))
        out.append(('robot restarts, memory lost', s2, 'env'))
    # quarantine and its owner-only exit
    if ev and can(s, QN):
        bud = list(s.bud)
        bud[QN] -= 1
        s2 = s._replace(Q=1, bud=tuple(bud))
        for i in (0, 1):
            if s.srv[i][0] == ACTIVE:
                s2 = end_req(s2, i)
        out.append(('quarantine', incident(s2), 'env'))
    if s.Q:
        out.append(('owner releases quarantine (owner only)', s._replace(Q=0), 'owner'))
    # motionless diagnostic path
    dres_out = any(m[0] == 'dres' for m in s.net)
    if s.R in (STOPPED, IDLE) and not dres_out and (s.CHK == 0 or s.U or s.SCHK == 0):
        if (not M.get('diag_needs_lease')) or any(l[0] == ACTIVE for l in s.srv):
            out.append(('diagnostic (state query + self check)',
                        s._replace(CHK=1, net=add(s.net, ('dres', s.memhi, s.ep, 0))), 'help'))
    # chief engineer decisions
    if (s.RE or s.SRE) and s.R == STOPPED:
        nissued = sum(1 for l in s.srv if l[0] != 0)
        out.append(('chief engineer re-enrols', s._replace(RE=0, SRE=0, memhi=nissued, lbn=max(s.lbn, s.bn)), 'help'))
    if (s.SCHK and not s.RE and not s.SRE and not s.U and not s.Q and s.R in (STOPPED, IDLE)
            and all(l[0] in (0, ENDED) for l in s.srv) and (s.P == 0 or s.R == STOPPED)
            and (s.CHK == 1 or M.get('lenient_restart') or M.get('restore_workflow'))):
        # the robot accepts a release only with a self check recorded in this boot (a restart the server has not yet
        # heard of cannot be released over)
        out.append(('chief engineer releases', s._replace(P=1, R=IDLE), 'help'))
    return out


DEAD = -100


def norm(s):
    """Canonical form: forget history that can no longer change any later transition (a state reduction only; each
    step below replaces a value by one that behaves identically from now on, because time only increases)."""
    t = s.t
    iss = tuple(x if (x >= 0 and t - x < H) else DEAD for x in s.iss)
    auth = s.auth if s.auth > t else -1
    pexp = s.pexp if s.pexp > t else 0
    srv = []
    for (st, A, exp, ln, hs) in s.srv:
        if st == ENDED or st == 0:
            srv.append((st, 0, 0, 0, 0))
        elif st == ENDING:
            srv.append((st, A, exp, 0, 0))
        else:
            srv.append((st, A, exp, ln, hs))
    net = []
    for m in s.net:
        kind, a, b, c = m
        if kind == 'pkg' and t >= b:
            continue                                   # expired package: delivery would change nothing
        if kind == 'chal' and s.srv[a][0] != ACTIVE:
            continue                                   # the server answers only an active lease
        if kind == 'ans' and (b != s.bn or iss[c - 1] == DEAD):
            continue                                   # other boot, or the robot's challenge is too old
        net.append(m)
    return s._replace(iss=iss, auth=auth, pexp=pexp, srv=tuple(srv), net=tuple(net))


def violations(s):
    v = []
    mot = set(i for i in (0, 1) if s.srv[i][0] == ACTIVE)
    if live(s):
        mot.add(s.pkg)
    if len(mot) > 1:
        v.append('I1 two leases allow motion at one time')
    if live(s) and s.srv[s.pkg][0] == ENDED:
        v.append('I2 a lease allows motion after the server considers it ended')
    if live(s) and s.CHK == 0:
        v.append('I4 motion allowed in a boot without a recorded self check')
    if any(c > 1 for c in s.execs):
        v.append('I3 a command executed twice')
    v.extend(s.flags)
    return v


def is_goal(s):
    return (s.R == IDLE and s.P == 1 and not s.U and not s.Q and not s.RE and not s.SRE
            and all(l[0] in (0, ENDED) for l in s.srv))


def explore(M, label):
    t0 = time.time()
    init = initial()
    ids = {init: 0}
    states = [init]
    parent = [(-1, '')]
    rev_help = [[]]          # reverse edges of routine, helpful transitions (no faults, no new activity)
    rev_owner = [[]]         # the same plus the owner-only exit
    q = deque([0])
    first = {}               # violation text -> state index (shortest trace first)
    nedges = 0
    while q:
        i = q.popleft()
        if i % 200000 == 0 and i:
            print('  ... %s: %d states seen, %d queued, t=%d, %.0f s' % (label, len(states), len(q), states[i].t,
                                                                          time.time() - t0), file=sys.stderr, flush=True)
        if len(states) > MAXSTATES:
            raise SystemExit('state cap %d reached: lower the bounds' % MAXSTATES)
        s = states[i]
        v = violations(s)
        if v:
            for x in v:
                first.setdefault(x, i)
            continue
        for lab, s2, kind in succ(s, M):
            s2 = norm(s2)
            nedges += 1
            j = ids.get(s2)
            if j is None:
                j = len(states)
                ids[s2] = j
                states.append(s2)
                parent.append((i, lab))
                rev_help.append([])
                rev_owner.append([])
                q.append(j)
            if kind == 'help':
                rev_help[j].append(i)
                rev_owner[j].append(i)
            elif kind == 'owner':
                rev_owner[j].append(i)
    # recovery: every non-violating state reaches a goal state by routine transitions
    bad_states = set(first.values())

    def backward(rev):
        good = set(i for i, s in enumerate(states) if is_goal(s) and i not in bad_states)
        stack = list(good)
        while stack:
            j = stack.pop()
            for i in rev[j]:
                if i not in good and i not in bad_states:
                    good.add(i)
                    stack.append(i)
        return good
    good_routine = backward(rev_help)
    good_owner = backward(rev_owner)
    stuck = [i for i in range(len(states)) if i not in bad_states and i not in good_owner]
    need_owner = [i for i in range(len(states)) if i not in bad_states and i in good_owner and i not in good_routine]
    result = {'label': label, 'states': len(states), 'edges': nedges, 'seconds': time.time() - t0,
              'violations': {}, 'stuck': len(stuck), 'need_owner': len(need_owner),
              'need_owner_not_quarantined': sum(1 for i in need_owner if not states[i].Q)}

    def trace(i):
        steps = []
        while i > 0:
            p, lab = parent[i]
            steps.append('t=%d %s' % (states[p].t, lab))
            i = p
        return list(reversed(steps))
    for x, i in first.items():
        result['violations'][x] = trace(i)
    if stuck:
        result['stuck_trace'] = trace(stuck[0])
        result['stuck_state'] = states[stuck[0]]
    return result


def report1(r):
    print('--- %s' % r['label'])
    print('states explored %d, transitions %d, %.1f s' % (r['states'], r['edges'], r['seconds']))
    if not r['violations'] and not r['stuck']:
        print('PASS: no invariant violated; every state reaches recovery without an owner decision '
              '(%d states need the owner-only quarantine exit, %d of them outside quarantine)'
              % (r['need_owner'], r['need_owner_not_quarantined']))
    for x, tr in r['violations'].items():
        print('FAIL %s' % x)
        print('   trace (%d steps): %s' % (len(tr), ' | '.join(tr)))
    if r['stuck']:
        print('FAIL I5 %d states have no legal path to recovery (a state: %s)' % (r['stuck'], r['stuck_state']))
        print('   trace to the first: %s' % ' | '.join(r['stuck_trace']))
    return not r['violations'] and not r['stuck'] and not r['need_owner_not_quarantined']


# ----------------------------------------------------------------------------------------------------------------------
# Part 2: Table 2, record life, as a creation-order search
# ----------------------------------------------------------------------------------------------------------------------
PP, NU = 1, 2     # confirmation reasons: people_possible, no_unattended_policy
T2 = namedtuple('T2', 'sub rv rvv qual stage adm pol conf cr press lease lref snap')
SUBJ = ('evidence_set', 'experiment_plan', 'stage_exit', 'unattended_policy')


def t2_initial():
    return T2(sub=(0, 0, 0, 0), rv=(0, 0, 0, 0), rvv=(0, 0, 0, 0), qual=0, stage=0, adm=0, pol=0, conf=0, cr=0,
              press=0, lease=0, lref='', snap=())


def t2_need(s, Z):
    return (PP if Z['zone_open'] else 0) | (NU if (s.press == 0 and s.pol != 2) else 0)


def rv_ok(s, k):
    """The review of subject k is final (confirmed) and was made on the subject as it is now."""
    return s.rv[k] == 3 and s.rvv[k] == s.sub[k] and s.sub[k] > 0


def g_review_insert(s, k, Z):
    if Z.get('old_insert_confirmed'):
        # old trigger: the verdict must be 'confirmed' at insert, but the verdict needs the reviewer's run, and
        # that run references the review row: the row cannot exist before the verdict, nor the verdict before the row.
        return s.sub[k] > 0 and s.rv[k] == 0 and s.rv[k] == 3
    return s.sub[k] > 0 and s.rv[k] == 0


def g_qual_decide(s):
    return s.qual == 1 and rv_ok(s, 0)


def g_stage_decide(s):
    return s.stage == 1 and rv_ok(s, 2)


def g_adm_insert(s):
    return s.adm == 0 and rv_ok(s, 1)


def g_pol_insert(s, Z):
    return Z['policy_on'] and s.pol == 0 and rv_ok(s, 3)


def g_lease_insert(s, ref, Z):
    if s.lease != 0:
        return False
    if ref == 'qual':
        if s.qual != 2:
            return False
    elif s.adm != 1:
        return False
    if Z['zone_open'] and not (s.conf == 2 and s.cr & PP):
        return False
    attended = s.press == 1
    if Z.get('old_attend') and s.conf == 2 and s.cr & PP:
        attended = True      # old reading: a confirmation that people MAY be present proves a person is attending
    if not (attended or s.pol == 2 or (s.conf == 2 and s.cr & NU)):
        return False
    return True


def t2_succ(s, Z):
    out = []
    for k in range(4):
        if s.sub[k] == 0 and (k != 3 or Z['policy_on']):
            sub = list(s.sub)
            sub[k] = 1
            out.append(('%s.create [system/chief engineer]' % SUBJ[k], s._replace(sub=tuple(sub))))
    if s.sub[0] == 1 and s.qual != 2:
        out.append(('evidence_set.amend', s._replace(sub=(2,) + s.sub[1:])))
    for k in range(4):
        if g_review_insert(s, k, Z):
            rv = list(s.rv)
            rvv = list(s.rvv)
            rv[k] = 1
            rvv[k] = s.sub[k]
            out.append(('review(%s).insert pending [system]' % SUBJ[k], s._replace(rv=tuple(rv), rvv=tuple(rvv))))
        if s.rv[k] == 1 and s.rvv[k] == s.sub[k]:
            rv = list(s.rv)
            rv[k] = 2
            out.append(('review(%s).attach independent run [reviewer]' % SUBJ[k], s._replace(rv=tuple(rv))))
        if s.rv[k] == 2 and s.rvv[k] == s.sub[k]:
            for verdict, name in ((3, 'confirmed'), (4, 'rejected')):
                rv = list(s.rv)
                rv[k] = verdict
                out.append(('review(%s).verdict %s [reviewer]' % (SUBJ[k], name), s._replace(rv=tuple(rv))))
    if s.sub[0] > 0 and s.qual == 0:
        out.append(('qualification.insert REVIEW_PENDING [system]', s._replace(qual=1)))
    if g_qual_decide(s):
        out.append(('qualification.QUALIFIED [chief engineer]', s._replace(qual=2)))
    if s.sub[2] > 0 and s.stage == 0:
        out.append(('stage.insert REVIEW_PENDING [system]', s._replace(stage=1)))
    if g_stage_decide(s):
        out.append(('stage.STANDING [chief engineer]', s._replace(stage=2)))
    if g_adm_insert(s):
        out.append(('admission.insert [chief engineer]', s._replace(adm=1)))
    if g_pol_insert(s, Z):
        out.append(('policy.insert active [chief engineer]', s._replace(pol=2)))
    if s.pol == 2:
        out.append(('policy.expire', s._replace(pol=3)))
    if Z['press_on'] and s.press == 0:
        out.append(('start press of a person at the start', s._replace(press=1)))
    if s.conf == 0:
        for r in (PP, NU, PP | NU):
            out.append(('confirmation.first press reasons=%d [chief engineer]' % r, s._replace(conf=1, cr=r)))
    if s.conf == 1 and (t2_need(s, Z) & ~s.cr) == 0:
        out.append(('confirmation.second press [owner]', s._replace(conf=2)))
    for ref in ('qual', 'adm'):
        if g_lease_insert(s, ref, Z):
            used_conf = s.conf == 2 and (Z['zone_open'] or (s.press == 0 and s.pol != 2))
            snap = (s.press, 1 if s.pol == 2 else 0, s.cr if used_conf else 0, 1 if Z['zone_open'] else 0)
            out.append(('lease.insert ref=%s [gateway]' % ref,
                        s._replace(lease=1, lref=ref, adm=2 if ref == 'adm' else s.adm,
                                   conf=3 if used_conf else s.conf, snap=snap)))
    return out


def t2_violations(s, Z):
    v = []
    if s.qual == 2 and not rv_ok(s, 0):
        v.append('T2-4 qualification usable without a final, matching review')
    if s.stage == 2 and not rv_ok(s, 2):
        v.append('T2-4 stage usable without a final, matching review')
    if s.adm >= 1 and not rv_ok(s, 1):
        v.append('T2-4 admission usable without a final, matching review')
    if s.pol >= 2 and not rv_ok(s, 3):
        v.append('T2-4 policy usable without a final, matching review')
    if s.lease == 1:
        press, pol, cr, zone = s.snap
        if s.lref == 'qual' and not (s.qual == 2 and rv_ok(s, 0)):
            v.append('T2-5 lease on a qualification that is not final')
        if s.lref == 'adm' and not (s.adm >= 1 and rv_ok(s, 1)):
            v.append('T2-5 lease on an admission that is not final')
        if zone and not (cr & PP):
            v.append('T2-6 open zone without a people_possible confirmation')
        if not (press == 1 or pol == 1 or (cr & NU)):
            v.append('T2-7 unattended start without a policy, a start press or a no_unattended_policy reason')
    if s.adm == 2 and not (s.lease == 1 and s.lref == 'adm'):
        v.append('T2-8 admission used outside the lease insert')
    return v


def t2_guard_attempts(Z):
    """Every relying write, attempted in every combination of the states it reads: it is accepted only when the
    records it relies on are final. This is the 'no use before the final state' check."""
    bad = []
    base = t2_initial()
    for rv in range(5):
        for rvv in range(3):
            for sub in range(3):
                s = base._replace(rv=(rv,) * 4, rvv=(rvv,) * 4, sub=(sub,) * 4, qual=1, stage=1)
                final = rv == 3 and rvv == sub and sub > 0
                for name, ok in (('qualification.QUALIFIED', g_qual_decide(s)), ('stage.STANDING', g_stage_decide(s)),
                                 ('admission.insert', g_adm_insert(s)), ('policy.insert', g_pol_insert(s, Z))):
                    if ok and not final:
                        bad.append('%s accepted with review state %d version %d subject %d' % (name, rv, rvv, sub))
    for qual in range(3):
        for adm in range(3):
            for conf in range(4):
                for cr in range(4):
                    for press in range(2):
                        for pol in (0, 2, 3):
                            for ref in ('qual', 'adm'):
                                s = base._replace(qual=qual, adm=adm, conf=conf, cr=cr, press=press, pol=pol)
                                if not g_lease_insert(s, ref, Z):
                                    continue
                                if (ref == 'qual' and qual != 2) or (ref == 'adm' and adm != 1):
                                    bad.append('lease accepted with a gate-3 reference that is not final')
                                if Z['zone_open'] and not (conf == 2 and cr & PP):
                                    bad.append('lease accepted in an open zone without a people_possible confirmation')
                                if not (press == 1 or pol == 2 or (conf == 2 and cr & NU)):
                                    bad.append('lease accepted for an unattended start (press=%d pol=%d conf=%d reasons=%d)'
                                               % (press, pol, conf, cr))
    return sorted(set(bad))


def t2_explore(Z):
    init = t2_initial()
    seen = {init: None}
    q = deque([init])
    viol = {}
    while q:
        s = q.popleft()
        v = t2_violations(s, Z)
        for x in v:
            viol.setdefault(x, s)
        if v:
            continue
        for lab, s2 in t2_succ(s, Z):
            if s2 not in seen:
                seen[s2] = (s, lab)
                q.append(s2)

    def trace(s):
        steps = []
        while seen[s] is not None:
            s, lab = seen[s]
            steps.append(lab)
        return list(reversed(steps))
    goals = {
        'review(evidence_set) confirmed': lambda s: s.rv[0] == 3,
        'review(experiment_plan) confirmed': lambda s: s.rv[1] == 3,
        'review(stage_exit) confirmed': lambda s: s.rv[2] == 3,
        'qualification QUALIFIED': lambda s: s.qual == 2,
        'stage STANDING': lambda s: s.stage == 2,
        'admission admitted': lambda s: s.adm == 1,
        'admission used by a lease': lambda s: s.adm == 2,
        'confirmation confirmed': lambda s: s.conf == 2,
        'confirmation used by a lease': lambda s: s.conf == 3,
        'lease inserted on a qualification': lambda s: s.lease == 1 and s.lref == 'qual',
        'lease inserted on an admission': lambda s: s.lease == 1 and s.lref == 'adm',
    }
    if Z['policy_on']:
        goals['policy active'] = lambda s: s.pol == 2
        goals['review(unattended_policy) confirmed'] = lambda s: s.rv[3] == 3
    unreachable = [g for g, f in goals.items() if not any(f(s) for s in seen)]
    return seen, viol, unreachable, trace


def run_part2(switches):
    allok = True
    for label, Z0 in (('new rules', {}), ('old rule: review inserted confirmed', {'old_insert_confirmed': True}),
                      ('old rule: people_possible proves attendance', {'old_attend': True})):
        if Z0 and not (set(Z0) & switches) and switches != {'all'}:
            continue
        print('--- Table 2, %s' % label)
        total = 0
        ok = True
        nfail = 0
        for zone_open in (0, 1):
            for press_on in (0, 1):
                for policy_on in (0, 1):
                    Z = dict(Z0, zone_open=zone_open, press_on=press_on, policy_on=policy_on)
                    seen, viol, unreachable, trace = t2_explore(Z)
                    total += len(seen)
                    attempts = t2_guard_attempts(Z)
                    name = 'zone=%s start press=%s policy=%s' % ('open' if zone_open else 'fenced',
                                                                 'possible' if press_on else 'none',
                                                                 'possible' if policy_on else 'none')
                    problems = []
                    for x, s in viol.items():
                        problems.append('%s | trace: %s' % (x, ' | '.join(trace(s))))
                    for g in unreachable:
                        problems.append('T2-1/2/3 never reachable: %s' % g)
                    for a in attempts:
                        problems.append('T2-5/T2-7 guard attempt (a lease insert the database must refuse): %s' % a)
                    if problems:
                        ok = False
                        nfail += 1
                        if nfail <= 2 or not Z0:
                            print('FAIL scenario %s (%d states)' % (name, len(seen)))
                            for p in problems[:6]:
                                print('   ' + p)
                            if len(problems) > 6:
                                print('   ... %d more' % (len(problems) - 6))
        print('%s: %d states over 8 scenarios, %d scenarios failing' % ('PASS' if ok else 'FAIL', total, nfail))
        if not Z0:
            allok = allok and ok
        else:
            allok = allok and (not ok)      # a mutation must be caught
    return allok


# ----------------------------------------------------------------------------------------------------------------------
def main(argv):
    global FAULT_CAP
    what = argv[1] if len(argv) > 1 else 'all'
    global BUDGET
    names = {'loss': LOSS, 'dup': DUP, 'rm': RM, 'rn': RN, 'qn': QN, 'ss': SS}
    for a in argv[2:]:
        if a.startswith('cap='):
            FAULT_CAP = int(a[4:])
        if a.startswith('faults='):          # faults=loss,rm : only these faults, one of each, at most all of them
            sel = [x for x in a[7:].split(',') if x]
            b = [0] * 7
            b[ER] = 1
            for x in sel:
                b[names[x]] = 1
            BUDGET = tuple(b)
            FAULT_CAP = len(sel)
    only = set(a for a in argv[2:] if not a.startswith(('cap=', 'faults=')))
    nomut = 'nomut' in only          # new rules only, no mutants (used for the single and paired fault runs)
    only.discard('nomut')
    ok = True
    global NCMD, NISSUE
    if what in ('part1', 'all'):
        # two profiles keep each exhaustive search small: the authority profile has two leases and no commands,
        # the command profile has one lease and its commands
        profiles = (
            ('authority', 0, 2, (
                ('old_hb', 'old rule: a delayed heartbeat counts fresh from receipt'),
                ('lenient_restart', 'old rule: restart with intact memory needs only a new lease'),
                ('diag_needs_lease', 'old rule: the diagnostic needs a lease'),
                ('issue_while_ending', 'mutation: a new lease while the old one is still ending'),
                ('restore_workflow', 'mutation: restart restores the old package'))),
            ('commands', 2, 1, (
                ('no_seq_check', 'mutation: no command sequence check'),
                ('restore_workflow', 'mutation: restart restores the old package and queue'))),
        )
        for pname, ncmd, nissue, mutants in profiles:
            if only and not (only & {pname, 'new'} | set(k for k, _ in mutants)):
                continue
            NCMD, NISSUE = ncmd, nissue
            if not only or pname in only or 'new' in only:
                r = explore({}, 'Table 1 [%s], new rules' % pname)
                ok = report1(r) and ok
            for key, label in mutants:
                if nomut or (only and key not in only and pname not in only):
                    continue
                r = explore({key: True}, 'Table 1 [%s], %s' % (pname, label))
                caught = bool(r['violations']) or bool(r['stuck']) or bool(r['need_owner_not_quarantined'])
                report1(r)
                print('   -> %s' % ('caught' if caught else 'NOT CAUGHT'))
                ok = ok and caught
    if what in ('part2', 'all'):
        ok = run_part2(only or {'all'}) and ok
    print('RESULT: %s' % ('all new rules pass, all old rules caught' if ok else 'PROBLEM'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
