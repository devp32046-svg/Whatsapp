#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CGPE FAMILY GROUPING ENGINE
===========================
Identifies FAMILIES and MASTER FAMILY GROUPS (grand-families) from Gujarati
client names.  (Reference engine supplied by CGPE — verbatim.)
"""

import re
import csv
import argparse
import unicodedata
from collections import defaultdict

# --------------------------------------------------------------------------- #
#  1. CONFIGURATION
# --------------------------------------------------------------------------- #

MALE_SUFFIXES = [
    "bhai", "kumar", "kumaar", "lal", "laal", "das", "daas",
    "sinh", "singh", "chandra", "chand", "prasad", "rai", "ray",
]
FEMALE_SUFFIXES = [
    "bahen", "behn", "ben", "kunwar", "kuvar", "gauri", "bala",
]

PREFIXES = {"shri", "shree", "sri", "smt", "kum", "ku", "dr", "mr", "mrs",
            "ms", "late", "l", "m/s"}

GENDER_SEED = {
    "manan": "M", "meet": "M", "harsh": "M", "amit": "M", "raj": "M",
    "dhruv": "M", "dhruval": "M", "jay": "M", "dev": "M", "krish": "M",
    "parth": "M", "yash": "M", "arjun": "M", "rohan": "M", "kunj": "M",
    "nihar": "M", "smit": "M", "tirth": "M", "vraj": "M", "hardik": "M",
    "nilesh": "M", "mihir": "M", "krunal": "M", "jainam": "M", "aryan": "M",
    "krisha": "F", "priya": "F", "nisha": "F", "riya": "F", "isha": "F",
    "khushi": "F", "heena": "F", "hina": "F", "dhara": "F", "kinjal": "F",
    "nidhi": "F", "shreya": "F", "aditi": "F", "diya": "F",
    "vidhi": "F", "janvi": "F", "hetvi": "F", "mahek": "F", "tvisha": "F",
}

WIFE_MAX_AGE_GAP = 16
PARENT_MIN_AGE_GAP = 15

# --------------------------------------------------------------------------- #
#  2. NAME NORMALISATION
# --------------------------------------------------------------------------- #

def _ascii(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower()

def clean_token(tok: str) -> str:
    return re.sub(r"[^a-z]", "", _ascii(tok))

def strip_suffix(core: str):
    for suf in sorted(FEMALE_SUFFIXES, key=len, reverse=True):
        if core.endswith(suf) and len(core) - len(suf) >= 3:
            return core[: -len(suf)], "F"
    for suf in sorted(MALE_SUFFIXES, key=len, reverse=True):
        if core.endswith(suf) and len(core) - len(suf) >= 3:
            return core[: -len(suf)], "M"
    return core, None

def core_key(tok: str) -> str:
    c = clean_token(tok)
    c, _ = strip_suffix(c)
    c = re.sub(r"[aeiou]+$", "", c)
    return c

def surname_key(tok: str) -> str:
    return clean_token(tok)

def _lev(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a or not b:
        return max(len(a), len(b))
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1,
                           prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]

def keys_match(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a == b:
        return True
    if min(len(a), len(b)) >= 5 and _lev(a, b) <= 1:
        return True
    return False

# --------------------------------------------------------------------------- #
#  3. PERSON MODEL
# --------------------------------------------------------------------------- #

class Person:
    __slots__ = ("pid", "raw", "first", "middle", "surname",
                 "first_k", "middle_k", "surname_k",
                 "gender", "age", "married", "notes",
                 "family_id", "unit_id", "role", "generation", "confidence")

    def __init__(self, pid, raw, first, middle, surname, gender, age, married):
        self.pid = pid
        self.raw = raw
        self.first = first
        self.middle = middle
        self.surname = surname
        self.first_k = core_key(first) if first else ""
        self.middle_k = core_key(middle) if middle else ""
        self.surname_k = surname_key(surname) if surname else ""
        self.gender = gender
        self.age = age
        self.married = married
        self.notes = []
        self.family_id = ""
        self.unit_id = ""
        self.role = ""
        self.generation = None
        self.confidence = "high"

def infer_gender_from_name(first_raw: str):
    c = clean_token(first_raw)
    _, g = strip_suffix(c)
    if g:
        return g
    if c in GENDER_SEED:
        return GENDER_SEED[c]
    stem, _ = strip_suffix(c)
    if stem in GENDER_SEED:
        return GENDER_SEED[stem]
    return "?"

def parse_name(raw: str):
    txt = _ascii(raw)
    txt = txt.replace(".", " ").replace(",", " ").replace("/", " ")
    toks = [t for t in re.split(r"\s+", txt) if t]
    toks = [t for t in toks if clean_token(t) not in PREFIXES]
    toks = [t for t in toks if clean_token(t)]
    if not toks:
        return "", "", ""
    if len(toks) == 1:
        return toks[0], "", ""
    if len(toks) == 2:
        return toks[0], "", toks[1]
    return toks[0], toks[-2], toks[-1]

# --------------------------------------------------------------------------- #
#  4. LOAD
# --------------------------------------------------------------------------- #

def parse_age(v):
    if v is None:
        return None
    s = str(v).strip().lower()
    if s in ("", "n/a", "na", "nan", "none", "-", "?"):
        return None
    m = re.search(r"\d+", s)
    return int(m.group()) if m else None

def load_people(rows):
    people = []
    for i, row in enumerate(rows):
        low = {k.strip().lower(): (v.strip() if isinstance(v, str) else v)
               for k, v in row.items() if k}

        pid = low.get("id") or low.get("client_id") or f"P{i+1:04d}"

        if low.get("first_name") or low.get("surname") or low.get("middle_name"):
            first = low.get("first_name", "")
            middle = low.get("middle_name", "")
            surname = low.get("surname", "") or low.get("last_name", "")
            raw = " ".join(x for x in (first, middle, surname) if x)
        else:
            raw = low.get("full_name") or low.get("name") or ""
            first, middle, surname = parse_name(raw)

        g = (low.get("gender") or low.get("sex") or "").strip().upper()
        gender = g[0] if g[:1] in ("M", "F") else infer_gender_from_name(first)

        age = parse_age(low.get("age"))
        if age is None and low.get("dob"):
            y = re.search(r"(19|20)\d{2}", str(low["dob"]))
            if y:
                age = 2026 - int(y.group())

        ms = (low.get("marital_status") or low.get("married") or "").strip().lower()
        if ms in ("married", "m", "yes", "y", "true", "1"):
            married = True
        elif ms in ("unmarried", "single", "u", "no", "n", "false", "0"):
            married = False
        else:
            married = None

        person = Person(pid, raw or "(blank)", first, middle, surname,
                        gender, age, married)
        if not person.surname_k:
            person.confidence = "low"
            person.notes.append("no surname in record")
        if not person.middle_k and person.surname_k:
            person.notes.append("no father/husband name (cannot auto-link)")
        people.append(person)
    return people

# --------------------------------------------------------------------------- #
#  5. UNION-FIND
# --------------------------------------------------------------------------- #

class DSU:
    def __init__(self):
        self.p = {}
    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x
    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb

# --------------------------------------------------------------------------- #
#  6. CORE GROUPING
# --------------------------------------------------------------------------- #

def group_families(people):
    dependents = defaultdict(list)
    for p in people:
        if p.middle_k:
            dependents[(p.surname_k, p.middle_k)].append(p)

    males_by_first = defaultdict(list)
    for p in people:
        if p.gender == "M" and p.first_k:
            males_by_first[(p.surname_k, p.first_k)].append(p)

    def is_head(male):
        return bool(dependents.get((male.surname_k, male.first_k)))

    def find_father_head(dep):
        cands = males_by_first.get((dep.surname_k, dep.middle_k), [])
        cands = [m for m in cands if m.pid != dep.pid]
        if not cands:
            for (sk, fk), ms in males_by_first.items():
                if sk == dep.surname_k and keys_match(fk, dep.middle_k):
                    cands.extend(m for m in ms if m.pid != dep.pid)
        if not cands:
            return None
        if dep.age is not None:
            parents = [m for m in cands if m.age is not None
                       and m.age - dep.age >= PARENT_MIN_AGE_GAP]
            if parents:
                return max(parents, key=lambda m: m.age)
        aged = [m for m in cands if m.age is not None]
        return max(aged, key=lambda m: m.age) if aged else cands[0]

    unit_of = {}
    head_pid = {}
    for p in people:
        if p.gender == "M":
            if is_head(p):
                key = (p.surname_k, p.first_k)
                unit_of[p.pid] = key
                head_pid.setdefault(key, p.pid)
            else:
                father = find_father_head(p) if p.middle_k else None
                if father:
                    unit_of[p.pid] = (father.surname_k, father.first_k)
                else:
                    key = (p.surname_k, p.first_k)
                    unit_of[p.pid] = key
                    head_pid.setdefault(key, p.pid)
                    p.notes.append("standalone (no dependents, no father in data)")
        else:
            husb_or_father = find_father_head(p) if p.middle_k else None
            if husb_or_father:
                unit_of[p.pid] = (husb_or_father.surname_k, husb_or_father.first_k)
            else:
                key = (p.surname_k, p.first_k or p.middle_k)
                unit_of[p.pid] = key
                head_pid.setdefault(key, p.pid)
                p.confidence = "low"
                p.notes.append("female with no matching male in data")

    members_by_unit = defaultdict(list)
    for p in people:
        members_by_unit[unit_of[p.pid]].append(p)
    for key, mem in members_by_unit.items():
        if key not in head_pid:
            males = [m for m in mem if m.gender == "M"]
            pick = max(males or mem,
                       key=lambda x: (x.age if x.age is not None else -1))
            head_pid[key] = pick.pid

    dsu = DSU()
    for key in members_by_unit:
        dsu.find(key)
    head_by_key = {k: next(p for p in members_by_unit[k] if p.pid == head_pid[k])
                   for k in members_by_unit}
    for key, head in head_by_key.items():
        if head.middle_k:
            for pkey, phead in head_by_key.items():
                if pkey == key:
                    continue
                if pkey[0] == key[0] and keys_match(phead.first_k, head.middle_k):
                    if (head.age is None or phead.age is None
                            or phead.age - head.age >= PARENT_MIN_AGE_GAP):
                        dsu.union(key, pkey)

    fam_units = defaultdict(list)
    for key in members_by_unit:
        fam_units[dsu.find(key)].append(key)

    families = {}
    fam_counter = 0
    for root, unit_keys in fam_units.items():
        fam_counter += 1
        heads = [head_by_key[k] for k in unit_keys]
        def has_parent(h):
            return any(k[0] == h.surname_k and keys_match(head_by_key[k].first_k, h.middle_k)
                       and head_by_key[k].pid != h.pid for k in unit_keys)
        root_heads = [h for h in heads if h.middle_k and not has_parent(h)] or heads
        root_head = max(root_heads, key=lambda h: (h.age if h.age is not None else -1))
        surname_disp = root_head.surname.title()
        fam_id = f"{root_head.surname_k.upper()}-{root_head.first_k.upper()}-{fam_counter:04d}"

        root_key = (root_head.surname_k, root_head.first_k)
        gen = {root_key: 1}
        changed = True
        while changed:
            changed = False
            for k in unit_keys:
                h = head_by_key[k]
                for pk in unit_keys:
                    ph = head_by_key[pk]
                    if pk != k and pk[0] == k[0] and h.middle_k \
                       and keys_match(ph.first_k, h.middle_k) and pk in gen \
                       and k not in gen:
                        gen[k] = gen[pk] + 1
                        changed = True
        for k in unit_keys:
            gen.setdefault(k, 1)

        unit_order = sorted(unit_keys,
                            key=lambda kk: (gen[kk], head_by_key[kk].first_k))

        for k in unit_keys:
            head = head_by_key[k]
            g = gen[k]
            mem = members_by_unit[k]
            females = [m for m in mem if m.gender == "F" and m.pid != head.pid]
            wife = None
            if females:
                if head.age is not None and any(f.age is not None for f in females):
                    near = [f for f in females if f.age is not None
                            and abs(f.age - head.age) <= WIFE_MAX_AGE_GAP]
                    wife = (max(near, key=lambda f: f.age) if near
                            else max((f for f in females if f.age is not None),
                                     key=lambda f: f.age, default=None))
                else:
                    wife = females[0]
            for m in mem:
                m.family_id = fam_id
                m.unit_id = f"{fam_id}-U{unit_order.index(k)+1:02d}"
                m.generation = g
                if m.pid == head.pid:
                    m.role = "Patriarch" if g == 1 else ("Head (Son)" if g == 2
                             else "Head (Grandson)")
                elif wife and m.pid == wife.pid:
                    m.role = "Wife" + (" (Matriarch)" if g == 1 else "")
                elif m.gender == "F":
                    m.role = "Daughter"
                    if m.age is not None and head.age is not None \
                       and head.age - m.age < PARENT_MIN_AGE_GAP:
                        m.confidence = "low"
                        m.notes.append("female younger-gap unclear (wife vs daughter)")
                else:
                    m.role = "Son"

        families[fam_id] = {
            "family_id": fam_id,
            "surname": surname_disp,
            "root_head": root_head,
            "unit_keys": sorted(unit_keys, key=lambda k: (gen[k], head_by_key[k].first_k)),
            "gen": gen,
            "head_by_key": head_by_key,
            "members_by_unit": members_by_unit,
        }
    return families

# --------------------------------------------------------------------------- #
#  7. OUTPUT (flat rows / csv only — visual outputs omitted for this run)
# --------------------------------------------------------------------------- #

def flat_rows(families):
    rows = []
    for fam_id, f in sorted(families.items()):
        for k in f["unit_keys"]:
            for m in f["members_by_unit"][k]:
                rows.append({
                    "client_id": m.pid,
                    "full_name": m.raw,
                    "first_name": m.first.title(),
                    "father_or_husband": m.middle.title(),
                    "surname": m.surname.title(),
                    "gender": m.gender,
                    "age": m.age if m.age is not None else "",
                    "family_id": m.family_id,
                    "family_surname": f["surname"],
                    "unit_id": m.unit_id,
                    "generation": m.generation,
                    "role_in_family": m.role,
                    "confidence": m.confidence,
                    "review_notes": "; ".join(m.notes),
                })
    return rows

def write_csv(rows, path):
    if not rows:
        return
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

def read_input(path):
    with open(path, newline="", encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))

def main():
    ap = argparse.ArgumentParser(description="CGPE family grouping from Gujarati names.")
    ap.add_argument("input", help="clients CSV")
    ap.add_argument("-o", "--out", default="family_groups")
    args = ap.parse_args()

    people = load_people(read_input(args.input))
    families = group_families(people)
    rows = flat_rows(families)
    write_csv(rows, args.out + ".csv")

    n_low = sum(1 for r in rows if r["confidence"] == "low")
    print(f"Summary: {len(people)} people -> {len(families)} master families,"
          f" {len({r['unit_id'] for r in rows})} nuclear units."
          f"  {n_low} row(s) flagged for review.")
    print(f"Wrote: {args.out}.csv")

if __name__ == "__main__":
    main()
