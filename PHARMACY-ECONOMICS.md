# Pharmacy economics: how the two structures actually compare

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
