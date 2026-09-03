# Pharmacy economics: how the two structures actually compare

> **Superseded by RULES.md.** Read that first. Anything here that contradicts it is dead.
> This file is kept for background and examples only.


**Source: Eric, 2026-08-26.** These are structural facts, not estimates. Any formulary comparison,
past or future, must use these definitions. Getting the COGS treatment wrong flips the answer.

Let **C** = amounts collected on a claim, **G** = cost of goods, including dispense fee and shipping.

---

## MDRx

The physician's entity **pays for the medication up front**, then receives **65 percent of what is
collected**. MDRx retains 35 percent as its fee and bears the billing and collection risk.

> **Net to physician = 0.65C − G**

Cash flow: money leaves first. Eric's figure is roughly **60 days to turn positive**, and strong
after that.

## PDRx

**Cost of goods comes off the top, and the remainder is split 50/50.** It does **not** come out of
the physician's half.

> **Net to physician = 0.5 × (C − G) = 0.5C − 0.5G**

Cash flow: nothing is fronted by the physician.

---

## PBRx

**PBRx also takes medication cost off the top, then splits the remainder.** It does not come out of
the physician's portion only. Splits under discussion have ranged from 60 to 70 percent.

> **Net to physician = s x (C - G)**, where s is the agreed split

---

## The general rule

**MDRx is the only one of the three where the physician bears 100 percent of cost of goods.** PDRx
and PBRx both absorb their share of it before the split.

For any partner taking COGS off the top at split **s**, MDRx nets more only when:

```
G / C  <  (0.65 - s) / (1 - s)
```

| Partner split, COGS off top | MDRx wins only if COGS is below |
|---|---|
| 50 percent | 30 percent of collections |
| 60 percent | 12.5 percent of collections |
| 65 percent | never |
| 70 percent | never |

**At 65 percent or above with COGS off the top, MDRx cannot win on economics at any mix.** The splits
are nominally equal but the physician is carrying the entire drug cost on one side and half or none
of it on the other. Any comparison that sets MDRx at 65 against PBRx at 65 and calls them equivalent
is wrong on its face.

---

## The crossover

Setting the two equal:

```
0.65C − G  >  0.5C − 0.5G
0.15C      >  0.5G
G          <  0.30C
```

> **MDRx wins when cost of goods is under 30 percent of collections.**
> **PDRx wins when cost of goods is over 30 percent of collections.**

This is a property of the **individual practice's prescribing mix**, not a general truth about either
partner. A high-cost formulary can make the 50 percent deal genuinely better than the 65 percent deal,
which is counterintuitive and is exactly why it must be calculated rather than assumed.

The headline split alone tells you nothing. Comparing "65 versus 50" without the COGS treatment is
meaningless.

---

## The error to avoid

**Do not model PDRx as cost of goods coming out of the physician's portion.** That would give
`0.5C − G`, which understates PDRx badly and would recommend MDRx in cases where PDRx is the better
deal. Eric flagged this specifically so it does not recur.

Any prior comparison work that assumed otherwise should be re-checked before it is relied on again,
including the split analyses run against competing formularies.

---

## What is equal between them

Neither of these is a differentiator, so neither belongs in a recommendation:

- Both pharmacies are in the Philadelphia suburbs.
- Both ship overnight.
- Both are strong at collections.

The decision rests on two things only: **the COGS ratio on that practice's mix**, and **whether the
practice can float roughly 60 days of medication cost.**

---

## How to advise

1. Ask whether the practice can comfortably front about 60 days of medication cost.
   - **No** → PDRx. No capital at risk, and the structure is honest.
   - **Yes** → run their actual top prescribed drugs against both and calculate.
2. Recommend one, name the other, and say why. A physician who is handed a menu has been handed
   homework, and a man who is ready to move stops moving.
3. Where a physician has already spoken to the other party, name it openly. Concealing an option he
   already knows about costs more than the deal is worth.
