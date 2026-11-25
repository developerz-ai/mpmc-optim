# 📚 Papers

**Rule: cite a paper for what its abstract or text says, not for what folklore says it says.** Every row below had its title, authors, venue and year checked against a registry record. As of 2026-11.

Status column, be strict about it:

| Mark | Meaning |
|---|---|
| **A** | Abstract read this session (arXiv or publisher record). Claim column paraphrases it |
| **M** | Bibliographic record only (Crossref DOI record, or the WG21 index). Claim column is the title-level claim; read the paper before relying on any detail |

Nothing here was read in full this session. **No evidence or hardware column**: none was verified, so none is printed. Before quoting a number from any of these, open the paper and record machine, thread count and workload ([19-benchmarking.md](19-benchmarking.md)). Venue for `ACM SIGPLAN Notices` records is the conference the issue reprints (PPoPP, POPL, PLDI, ASPLOS, OOPSLA).

## Read these 12 first

| # | Paper | Why |
|---|---|---|
| 1 | Herlihy, Wing 1990 | Defines the correctness contract of goal 1 |
| 2 | Michael, Scott 1996 | Baseline every queue paper compares against |
| 3 | Morrison, Afek 2013 (LCRQ) | Ring of slots plus fetch-and-add tickets |
| 4 | Nikolaev 2019 (SCQ) | Bounded, ABA-safe, no reclamation, portable |
| 5 | Romanov, Koval 2023 (LPRQ) | LCRQ without double-width CAS |
| 6 | Aksenov et al. 2024 | What memory overhead a bounded queue cannot avoid |
| 7 | Nikolaev, Ravindran 2022 (wCQ) | Wait-free with bounded memory |
| 8 | Lahav et al. 2017 (RC11) | The fixed C++11 model the checkers implement |
| 9 | Kokologiannakis, Vafeiadis 2021 (GenMC) | Candidate model checker (undecided) |
| 10 | David, Guerraoui, Trigonakis 2013 | What synchronization costs on real machines |
| 11 | Mytkowicz et al. 2009 | Why an unpinned, single-layout benchmark lies |
| 12 | P0260 | The standard queue API we must not contradict by accident |

Reading paths: **algorithms** 2, 3, 4, 5, 7, 6. **Memory model** Boehm-Adve, Batty, 8, Podkopaev, P0668. **Performance** 10, Schweizer, 11, Curtsinger-Berger, Hoefler-Belli, Yasin. **Verification** 1, Wing-Gong, Lowe, 9, Norris-Demsky, Burckhardt PCT.

## Concurrent FIFO queues

| Paper | Year, venue | Claim in plain words | What we take, caveat | St |
|---|---|---|---|---|
| [Michael, Scott: Simple, fast, and practical non-blocking and blocking concurrent queue algorithms](https://doi.org/10.1145/248052.248106) | 1996, PODC | Linked-list lock-free queue and a two-lock queue | Baseline only. Allocates per push, breaks I5 | M |
| [Ladan-Mozes, Shavit: An optimistic approach to lock-free FIFO queues](https://doi.org/10.1007/s00446-007-0050-0) | 2007, Distributed Computing (DISC 2004) | Doubly linked list replaces one CAS per enqueue | Idea: move cost off the hot CAS | M |
| [Moir, Nussbaum, Shalev, Shavit: Using elimination to implement scalable and lock-free FIFO queues](https://doi.org/10.1145/1073970.1074013) | 2005, SPAA | Elimination applied to queues | Only pays near-empty; not for a ring | M |
| [Hoffman, Shalev, Shavit: The baskets queue](https://doi.org/10.1007/978-3-540-77096-1_29) | 2007, OPODIS | Concurrent enqueues share an unordered "basket" | Order among overlapping pushes is free to choose | M |
| [Morrison, Afek: Fast concurrent queues for x86 processors](https://doi.org/10.1145/2517327.2442527) | 2013, PPoPP | LCRQ: ring nodes driven by fetch-and-add | Core ticket idea. Needs CAS2; see LPRQ, SCQ | M |
| [Yang, Mellor-Crummey: A wait-free queue as fast as fetch-and-add](https://doi.org/10.1145/3016078.2851168) | 2016, PPoPP | Wait-free queue on a fetch-and-add fast path | wCQ abstract: blocks when memory is exhausted, so not strictly wait-free | M |
| [Nikolaev: A scalable, portable, and memory-efficient lock-free FIFO queue](https://arxiv.org/abs/1908.04511) | 2019, DISC | SCQ: bounded, lock-free, linearizable, ABA-safe, no allocator or reclamation, fetch-and-add on hot spots | First candidate for [03-algorithms.md](03-algorithms.md) | A |
| [Nikolaev, Ravindran: wCQ](https://doi.org/10.1145/3490148.3538572) ([arXiv](https://arxiv.org/abs/2201.02179)) | 2022, SPAA | SCQ plus fast-path-slow-path gives wait-freedom with bounded memory | Opt-in variant only (non-goal 4) | A |
| [Romanov, Koval: The state-of-the-art LCRQ concurrent queue algorithm does NOT require CAS2](https://doi.org/10.1145/3572848.3577485) | 2023, PPoPP | LCRQ-class queue with single-word CAS | Portability to targets without 128-bit CAS | M |
| [Aksenov, Koval, Kuznetsov, Paramonov: Memory bounds for concurrent bounded queues](https://doi.org/10.1145/3627535.3638497) ([arXiv](https://arxiv.org/abs/2104.15003)) | 2024, PPoPP | Asks whether an array plus constant overhead suffices; easy when ABA is precluded (LL/SC or distinct elements) | The per-slot sequence word is a cost to justify, not assume | A |
| [Kogan, Petrank: Wait-free queues with multiple enqueuers and dequeuers](https://doi.org/10.1145/2038037.1941585) | 2011, PPoPP | Wait-free MPMC queue by helping | History for [06-progress-and-reclamation.md](06-progress-and-reclamation.md) | M |
| [Kogan, Petrank: A methodology for creating fast wait-free data structures](https://doi.org/10.1145/2370036.2145835) | 2012, PPoPP | Fast-path-slow-path | The pattern wCQ reuses | M |
| [Tsigas, Zhang: A simple, fast and scalable non-blocking concurrent FIFO queue](https://doi.org/10.1145/378580.378611) | 2001, SPAA | Array-based non-blocking queue | Early ring; read its ABA assumptions first | M |
| [Feldman, Dechev: A wait-free multi-producer multi-consumer ring buffer](https://doi.org/10.1145/2835260.2835264) | 2015, ACM SIGAPP ACR | Wait-free MPMC ring | Compare slot protocol | M |
| [Orozco, Garcia, Khan, Livingston, Gao: Toward high-throughput algorithms on many-core architectures](https://doi.org/10.1145/2086696.2086728) | 2012, ACM TACO | Queue design for many-core throughput | Prior art row | M |
| [Arnautov, Felber, Fetzer, Trach: FFQ](https://doi.org/10.1109/ipdps.2017.41) | 2017, IPDPS | Fast single-producer multi-consumer queue | SPMC specialisation | M |
| [Wang, Zhang, Tang, Hua: B-Queue](https://doi.org/10.1007/s10766-012-0213-x) | 2012, IJPP | SPSC queue for core-to-core hand-off | Batching of index reads | M |
| [Lee, Bu, Chandranmenon: A lock-free, cache-efficient multi-core synchronization mechanism for line-rate network traffic monitoring](https://doi.org/10.1109/ipdps.2010.5470368) | 2010, IPDPS | MCRingBuffer: SPSC ring that batches control-variable updates | Cached head/tail in the handle | M |
| [Giacomoni, Moseley, Vachharajani: FastForward for efficient pipeline parallelism](https://doi.org/10.1145/1345206.1345215) | 2008, PPoPP | Cache-optimised SPSC queue | Slot value as the full/empty signal | M |
| [Adas, Friedman: Jiffy](https://arxiv.org/abs/2010.14189) ([ICDCN](https://doi.org/10.1145/3491003.3491004)) | 2022, ICDCN | Wait-free MPSC is cheaper than MPMC because MPMC needs helper structures | Specialise when one side is single | A |
| [Scherer, Lea, Scott: Scalable synchronous queues](https://doi.org/10.1145/1506409.1506431) | 2009, CACM (PPoPP 2006) | Hand-off queues without a buffer | Waiting design, [07-waiting.md](07-waiting.md) | M |
| [Naderibeni, Ruppert: A wait-free queue with polylogarithmic step complexity](https://doi.org/10.1007/s00446-024-00471-7) | 2024, Distributed Computing | Wait-free queue with polylog steps | Theory bound, not a fast path | M |
| [Roh, Wei, Ruppert, Fatourou, Jayanti, Shun: Aggregating funnels for faster fetch&add and queues](https://doi.org/10.1145/3710848.3710873) | 2025, PPoPP | Batch contended fetch-and-adds | Candidate fix for the ticket counter hot spot | M |
| [Motiwala: No cords attached: coordination-free concurrent lock-free queues](https://arxiv.org/abs/2511.09410) | 2025, arXiv | Strict FIFO, unbounded, bounded reclamation protection | Single-author preprint, not peer reviewed. Treat as hypothesis | A |
| [Lamport: Proving the correctness of multiprocess programs](https://doi.org/10.1109/tse.1977.229904) | 1977, IEEE TSE | Proof method for concurrent programs | Origin usually cited for the SPSC ring; confirm in text | M |

## Relaxed and priority queues

| Paper | Year, venue | Claim | Take, caveat | St |
|---|---|---|---|---|
| [Henzinger, Kirsch, Payer, Sezgin, Sokolova: Quantitative relaxation of concurrent data structures](https://doi.org/10.1145/2480359.2429109) | 2013, POPL | Framework to state how far out of order a pop may be | Vocabulary for a "documented weaker contract" | M |
| [Haas et al.: Distributed queues in shared memory](https://doi.org/10.1145/2482767.2482789) | 2013, Computing Frontiers | Many queues behind one interface | Sharding, [13-numa-and-topology.md](13-numa-and-topology.md) | M |
| [Kirsch, Lippautz, Payer: Fast and scalable, lock-free k-FIFO queues](https://doi.org/10.1007/978-3-642-39958-9_18) | 2013, PaCT | Up to k out of order | Bounded relaxation | M |
| [Afek, Korland, Yanovsky: Quasi-linearizability](https://doi.org/10.1007/978-3-642-17653-1_29) | 2010, OPODIS | Relaxed consistency condition | Contract wording | M |
| [Koch, Sanders, Williams: BlockFIFO & MultiFIFO](https://arxiv.org/abs/2507.22764) | 2025, arXiv (ALENEX 2026) | Two relaxed designs, one from MultiQueue, one ring based; beat strict FIFO queues on throughput | Not comparable to strict FIFO. Publish relaxed results separately | A |
| [Rihani, Sanders, Dementiev: MultiQueues](https://doi.org/10.1145/2755573.2755616) | 2015, SPAA | Relaxed priority queue from many queues and random choice | Non-goal; context | M |
| [Alistarh, Kopinsky, Li, Shavit: The SprayList](https://doi.org/10.1145/2858788.2688523) | 2015, PPoPP | Relaxed skiplist priority queue | Non-goal | M |
| [Lindén, Jonsson: A skiplist-based concurrent priority queue with minimal memory contention](https://doi.org/10.1007/978-3-319-03850-6_15) | 2013, OPODIS | Fewer contended writes per delete-min | Counting contended writes as the cost | M |
| [Alistarh, Kopinsky, Li, Nadiradze: The power of choice in priority scheduling](https://doi.org/10.1145/3087801.3087810) | 2017, PODC | Analysis of two-choice relaxed scheduling | Theory for sharded pops | M |
| [Postnikova, Koval, Nadiradze, Alistarh: Multi-queues can be state-of-the-art priority schedulers](https://doi.org/10.1145/3503221.3508432) | 2022, PPoPP | Tuned multi-queues as schedulers | Non-goal | M |

## Correctness and progress

| Paper | Year, venue | Claim | Take | St |
|---|---|---|---|---|
| [Herlihy, Wing: Linearizability](https://doi.org/10.1145/78969.78972) | 1990, ACM TOPLAS | Each operation appears to take effect at one instant inside its call | Goal 1 contract | M |
| [Herlihy: Wait-free synchronization](https://doi.org/10.1145/114005.102808) | 1991, ACM TOPLAS | Hierarchy of primitives by consensus power | Why CAS, not fetch-and-add alone | M |
| [Attiya et al.: Laws of order](https://doi.org/10.1145/1925844.1926442) | 2011, POPL | Some expensive synchronization cannot be removed | Do not hunt for a zero-RMW strict queue | M |
| [Ellen, Hendler, Shavit: On the inherent sequentiality of concurrent objects](https://doi.org/10.1137/08072646x) | 2012, SIAM J. Comput. | Lower bounds on concurrent objects | Limits of scaling one queue | M |
| [Alistarh, Censor-Hillel, Shavit: Are lock-free concurrent algorithms practically wait-free?](https://doi.org/10.1145/2591796.2591836) | 2014, STOC | Under a stochastic scheduler, lock-free behaves wait-free | Supports lock-free default. Assumes the scheduler model | M |
| [Herlihy, Luchangco, Moir: Obstruction-free synchronization](https://doi.org/10.1109/icdcs.2003.1203503) | 2003, ICDCS | Defines obstruction-freedom | Vocabulary in [01-vision.md](01-vision.md) | M |
| [Timnat, Petrank: A practical wait-free simulation for lock-free data structures](https://doi.org/10.1145/2692916.2555261) | 2014, PPoPP | Mechanical lock-free to wait-free conversion | Opt-in variant route | M |
| [Dechev, Pirkelbauer, Stroustrup: Understanding and effectively preventing the ABA problem in descriptor-based lock-free designs](https://doi.org/10.1109/isorc.2010.10) | 2010, ISORC | ABA analysis and prevention | Ticket width rule | M |

## Reclamation (unbounded variant only)

| Paper | Year, venue | St |
|---|---|---|
| [Michael: Hazard pointers](https://doi.org/10.1109/tpds.2004.8) | 2004, IEEE TPDS | M |
| [Hart, McKenney, Brown, Walpole: Performance of memory reclamation for lockless synchronization](https://doi.org/10.1016/j.jpdc.2007.04.010) | 2007, JPDC | M |
| [Desnoyers, McKenney, Stern, Dagenais, Walpole: User-level implementations of read-copy update](https://doi.org/10.1109/tpds.2011.159) | 2012, IEEE TPDS | M |
| [Brown: Reclaiming memory for lock-free data structures (DEBRA)](https://doi.org/10.1145/2767386.2767436) | 2015, PODC | M |
| [Balmau, Guerraoui, Herlihy, Zablotchi: Fast and robust memory reclamation for concurrent data structures](https://doi.org/10.1145/2935764.2935790) | 2016, SPAA | M |
| [Ramalhete, Correia: Brief announcement: hazard eras](https://doi.org/10.1145/3087556.3087588) | 2017, SPAA | M |
| [Wen, Izraelevitz, Cai, Beadle, Scott: Interval-based memory reclamation](https://doi.org/10.1145/3200691.3178488) | 2018, PPoPP | M |
| [Cohen: Every data structure deserves lock-free memory reclamation](https://doi.org/10.1145/3276513) | 2018, PACMPL (OOPSLA) | M |
| [Kang, Jung: A marriage of pointer- and epoch-based reclamation](https://doi.org/10.1145/3385412.3385978) | 2020, PLDI | M |
| [Singh, Brown, Mashtizadeh: NBR](https://doi.org/10.1145/3437801.3441625) | 2021, PPoPP | M |
| [Nikolaev, Ravindran: Snapshot-free, transparent, and robust memory reclamation (Hyaline)](https://doi.org/10.1145/3453483.3454090) | 2021, PLDI | M |
| [Sheffi, Herlihy, Petrank: VBR](https://doi.org/10.1145/3409964.3461817) | 2021, SPAA | M |
| [Anderson, Blelloch, Wei: Concurrent deferred reference counting with constant-time overhead](https://doi.org/10.1145/3453483.3454060) | 2021, PLDI | M |
| [Jung, Lee, Kim, Kang: Applying hazard pointers to more concurrent data structures](https://doi.org/10.1145/3558481.3591102) | 2023, SPAA | M |
| [Kim, Brown, Singh: Are your epochs too epic? Batch free can be harmful](https://doi.org/10.1145/3627535.3638491) | 2024, PPoPP | M |
| [Nikolaev, Ravindran: A family of fast and memory efficient lock- and wait-free reclamation (Crystalline journal form)](https://doi.org/10.1145/3658851) | 2024, PACMPL (PLDI) | M |

Use: pick a scheme in [06-progress-and-reclamation.md](06-progress-and-reclamation.md) from Hart 2007 and the 2020s papers, not from the 2004 paper alone. Kim 2024's title is the warning: batched frees interact with the allocator ([08-arenas-and-allocators.md](08-arenas-and-allocators.md)).

## Memory models, checking, tools

| Paper | Year, venue | Take | St |
|---|---|---|---|
| [Boehm: Threads cannot be implemented as a library](https://doi.org/10.1145/1064978.1065042) | 2005, PLDI | Why the language needs a memory model | M |
| [Boehm, Adve: Foundations of the C++ concurrency memory model](https://doi.org/10.1145/1379022.1375591) | 2008, PLDI | Data race is UB; basis of [05-memory-model.md](05-memory-model.md) | M |
| [Batty, Owens, Sarkar, Sewell, Weber: Mathematizing C++ concurrency](https://doi.org/10.1145/1925844.1926394) | 2011, POPL | Formal C++11 model | M |
| [Vafeiadis et al.: Common compiler optimisations are invalid in the C11 memory model](https://doi.org/10.1145/2775051.2676995) | 2015, POPL | The 2011 model is flawed | M |
| [Lahav, Vafeiadis, Kang, Hur, Dreyer: Repairing sequential consistency in C/C++11](https://doi.org/10.1145/3140587.3062352) | 2017, PLDI | RC11; mixing seq_cst with weaker orders was broken | M |
| [Kang, Hur, Lahav, Vafeiadis, Dreyer: A promising semantics for relaxed-memory concurrency](https://doi.org/10.1145/3093333.3009850) | 2017, POPL | Model for relaxed accesses | M |
| [Podkopaev, Lahav, Vafeiadis: Bridging the gap between programming languages and hardware weak memory models](https://doi.org/10.1145/3290382) | 2019, PACMPL (POPL) | IMM: one proof target for x86, Arm, POWER | M |
| [Sewell, Sarkar, Owens, Zappa Nardelli, Myreen: x86-TSO](https://doi.org/10.1145/1785414.1785443) | 2010, CACM | Store-buffer model of x86 | M |
| [Pulte, Flur, Deacon, French, Sarkar, Sewell: Simplifying ARM concurrency: multicopy-atomic axiomatic and operational models for ARMv8](https://doi.org/10.1145/3158107) | 2018, PACMPL (POPL) | Armv8 model | M |
| [Alglave, Maranget, Tautschnig: Herding cats](https://doi.org/10.1145/2666356.2594347) | 2014, PLDI and TOPLAS | Litmus tests and the herd tool | M |
| [Boehm: Can seqlocks get along with programming language memory models?](https://doi.org/10.1145/2247684.2247688) | 2012, MSPC | Racy reads are not expressible; see P1478 | M |
| [Lê, Pop, Cohen, Zappa Nardelli: Correct and efficient work-stealing for weak memory models](https://doi.org/10.1145/2517327.2442524) | 2013, PPoPP | Worked example of per-operation ordering proofs | M |
| [Kokologiannakis, Raad, Vafeiadis: Model checking for weakly consistent libraries](https://doi.org/10.1145/3314221.3314609) | 2019, PLDI | GenMC algorithm | M |
| [Kokologiannakis, Vafeiadis: GenMC](https://doi.org/10.1007/978-3-030-81685-8_20) | 2021, CAV | Tool paper | M |
| [Norris, Demsky: CDSChecker](https://doi.org/10.1145/2544173.2509514) | 2013, OOPSLA | Model checker for C/C++ atomics | M |
| [Abdulla et al.: Stateless model checking for TSO and PSO](https://doi.org/10.1007/s00236-016-0275-0) | 2016, Acta Informatica (TACAS 2015) | Nidhugg | M |
| [Luo, Demsky: C11Tester](https://doi.org/10.1145/3445814.3446711) | 2021, ASPLOS | Race detector for atomics | M |
| [Oberhauser et al.: VSync](https://doi.org/10.1145/3445814.3446748) | 2021, ASPLOS | Verify then weaken orderings, the method of our ordering audit | M |
| [Burckhardt, Kothari, Musuvathi, Nagarakatte: A randomized scheduler with probabilistic guarantees of finding bugs](https://doi.org/10.1145/1735971.1736040) | 2010, ASPLOS | PCT schedule fuzzing | M |
| [Wing, Gong: Testing and verifying concurrent objects](https://doi.org/10.1006/jpdc.1993.1015) | 1993, JPDC | History-search linearizability check | M |
| [Lowe: Testing for linearizability](https://doi.org/10.1002/cpe.3928) | 2016, CCPE | Faster checkers | M |
| [Horn, Kroening: Faster linearizability checking via P-compositionality](https://doi.org/10.1007/978-3-319-19195-9_4) | 2015, FORTE | Split histories to cut search | M |
| [Burckhardt, Dern, Musuvathi, Tan: Line-up](https://doi.org/10.1145/1809028.1806634) | 2010, PLDI | Automatic checker | M |
| [Koval et al.: Lincheck](https://doi.org/10.1007/978-3-031-37706-8_8) | 2023, CAV | Test framework design to copy | M |
| [Serebryany, Iskhodzhanov: ThreadSanitizer](https://doi.org/10.1145/1791194.1791203) | 2009, WBIA | Describes the first, Valgrind-based TSan, not today's | M |
| [Flanagan, Freund: FastTrack](https://doi.org/10.1145/1839676.1839699) | 2010, CACM (PLDI 2009) | Epoch trick behind fast race detection | M |
| [Nethercote, Seward: Valgrind](https://doi.org/10.1145/1273442.1250746) | 2007, PLDI | Why it serialises threads | M |
| [Stepanov, Serebryany: MemorySanitizer](https://doi.org/10.1109/cgo.2015.7054186) | 2015, CGO | Uninitialised reads | M |
| [Klees, Ruef, Cooper, Wei, Hicks: Evaluating fuzz testing](https://doi.org/10.1145/3243734.3243804) | 2018, CCS | Method rules for fuzz claims | M |

## Contention, allocators, layout, SIMD, compilers

| Paper | Year, venue | Take | St |
|---|---|---|---|
| [David, Guerraoui, Trigonakis: Everything you always wanted to know about synchronization but were afraid to ask](https://doi.org/10.1145/2517349.2522714) | 2013, SOSP | Cross-platform cost of synchronization | M |
| [Schweizer, Besta, Hoefler: Evaluating the cost of atomic operations on modern architectures](https://doi.org/10.1109/pact.2015.24) | 2015, PACT | CAS against fetch-and-add against swap | M |
| [Mellor-Crummey, Scott: Algorithms for scalable synchronization on shared-memory multiprocessors](https://doi.org/10.1145/103727.103729) | 1991, ACM TOCS | MCS queue lock | M |
| [Anderson: The performance of spin lock alternatives](https://doi.org/10.1109/71.80120) | 1990, IEEE TPDS | Backoff | M |
| [Dice, Hendler, Mirsky: Lightweight contention management for efficient compare-and-swap operations](https://doi.org/10.1007/978-3-642-40047-6_60) | 2013, Euro-Par | Backoff around CAS | M |
| [Hendler, Incze, Shavit, Tzafrir: Flat combining](https://doi.org/10.1145/1810479.1810540) | 2010, SPAA | One thread applies everyone's operations | M |
| [Fatourou, Kallimanis: Revisiting the combining synchronization technique](https://doi.org/10.1145/2370036.2145849) | 2012, PPoPP | CC-Synch | M |
| [Shavit, Zemach: Combining funnels](https://doi.org/10.1006/jpdc.2000.1621) | 2000, JPDC | Ancestor of aggregating funnels | M |
| [Roghanchi, Eriksson, Basu: ffwd](https://doi.org/10.1145/3132747.3132771) | 2017, SOSP | Delegation to one core | M |
| [Dice, Marathe, Shavit: Lock cohorting](https://doi.org/10.1145/2370036.2145848) | 2012, PPoPP | NUMA batching | M |
| [Dice, Kogan: Compact NUMA-aware locks](https://doi.org/10.1145/3302424.3303984) | 2019, EuroSys | NUMA-aware in one word | M |
| [Calciu, Sen, Balakrishnan, Aguilera: Black-box concurrent data structures for NUMA architectures](https://doi.org/10.1145/3093336.3037721) | 2017, ASPLOS | Per-node replicas plus a shared log | M |
| [Guerraoui et al.: Lock-unlock: is that all?](https://doi.org/10.1145/3301501) | 2019, ACM TOCS | No single best lock | M |
| [Liu, Berger: Sheriff](https://doi.org/10.1145/2076021.2048070); [Liu, Tian, Hu, Berger: Predator](https://doi.org/10.1145/2692916.2555244); [Liu, Liu: Cheetah](https://doi.org/10.1145/2854038.2854039) | 2011 OOPSLA; 2014 PPoPP; 2016 CGO | False-sharing detection | M |
| [Torrellas, Lam, Hennessy: False sharing and spatial locality in multiprocessor caches](https://doi.org/10.1109/12.286299) | 1994, IEEE TC | The original measurement | M |
| [Berger, McKinley, Blumofe, Wilson: Hoard](https://doi.org/10.1145/356989.357000) | 2000, ASPLOS | Allocator-induced false sharing | M |
| [Michael: Scalable lock-free dynamic memory allocation](https://doi.org/10.1145/996893.996848) | 2004, PLDI | Lock-free malloc | M |
| [Aigner, Kirsch, Lippautz, Sokolova: scalloc](https://doi.org/10.1145/2858965.2814294) | 2015, OOPSLA | Reserve large virtual memory, commit lazily (goal 5) | M |
| [Leijen, Zorn, de Moura: Mimalloc](https://doi.org/10.1007/978-3-030-34175-6_13) | 2019, APLAS | Free-list sharding | M |
| [Liétar et al.: snmalloc](https://doi.org/10.1145/3315573.3329980) | 2019, ISMM | Cross-thread frees as messages; fits producer-allocates, consumer-frees | M |
| [Powers, Tench, Berger, McGregor: Mesh](https://doi.org/10.1145/3314221.3314582) | 2019, PLDI | Compaction without moving pointers | M |
| [Maas et al.: Learning-based memory allocation for C++ server workloads](https://doi.org/10.1145/3373376.3378525) | 2020, ASPLOS | Lifetime-aware huge-page placement | M |
| [Zhou et al.: Characterizing a memory allocator at warehouse scale](https://doi.org/10.1145/3620666.3651350) | 2024, ASPLOS | TCMalloc in production | M |
| [Chilimbi, Hill, Larus: Cache-conscious structure layout](https://doi.org/10.1145/301631.301633) | 1999, PLDI | Hot/cold split | M |
| [Khuong, Morin: Array layouts for comparison-based searching](https://doi.org/10.1145/3053370) | 2017, ACM JEA | Layout beats asymptotics; measure | M |
| [Kanev et al.: Profiling a warehouse-scale computer](https://doi.org/10.1145/2749469.2750392) | 2015, ISCA | Where fleet cycles go | M |
| [Polychroniou, Raghavan, Ross: Rethinking SIMD vectorization for in-memory databases](https://doi.org/10.1145/2723372.2747645) | 2015, SIGMOD | Vertical vectorisation patterns | M |
| [Langdale, Lemire: Parsing gigabytes of JSON per second](https://doi.org/10.1007/s00778-019-00578-5) | 2019, VLDB Journal | Branch-free bitmask scanning | M |
| [Muła, Kurz, Lemire: Faster population counts using AVX2 instructions](https://doi.org/10.1093/comjnl/bxx046) | 2018, Computer Journal | Occupancy counting | M |
| [Lemire, Kaser, Kurz: Faster remainder by direct computation](https://doi.org/10.1002/spe.2689) | 2019, SPE | Index reduction for non-power-of-two capacity | M |
| [Richter, Alvarez, Dittrich: A seven-dimensional analysis of hashing methods](https://doi.org/10.14778/2850583.2850585) | 2015, PVLDB | Model for a full benchmark matrix | M |
| [Pettis, Hansen: Profile guided code positioning](https://doi.org/10.1145/93548.93550) | 1990, PLDI | Root of PGO layout | M |
| [Chen, Li, Moseley: AutoFDO](https://doi.org/10.1145/2854038.2854044) | 2016, CGO | Sampled profiles | M |
| [Panchenko, Auler, Nell, Ottoni: BOLT](https://doi.org/10.1109/cgo.2019.8661201) | 2019, CGO | Post-link layout | M |
| [Shen et al.: Propeller](https://doi.org/10.1145/3575693.3575727) | 2023, ASPLOS | Relinking optimiser | M |
| [Schkufza, Sharma, Aiken: Stochastic superoptimization](https://doi.org/10.1145/2499368.2451150) | 2013, ASPLOS | Search for shorter hot loops | M |

## Benchmarking method

| Paper | Year, venue | Take | St |
|---|---|---|---|
| [Mytkowicz, Diwan, Hauswirth, Sweeney: Producing wrong data without doing anything obviously wrong!](https://doi.org/10.1145/1508284.1508275) | 2009, ASPLOS | Link order and environment size bias results | M |
| [Curtsinger, Berger: Stabilizer](https://doi.org/10.1145/2499368.2451141) | 2013, ASPLOS | Randomise layout, then test | M |
| [Georges, Buytaert, Eeckhout: Statistically rigorous Java performance evaluation](https://doi.org/10.1145/1297105.1297033) | 2007, OOPSLA | Confidence intervals, not best-of | M |
| [Kalibera, Jones: Rigorous benchmarking in reasonable time](https://doi.org/10.1145/2464157.2464160) | 2013, ISMM | How many repetitions at which level | M |
| [Hoefler, Belli: Scientific benchmarking of parallel computing systems](https://doi.org/10.1145/2807591.2807644) | 2015, SC | Twelve reporting rules | M |
| [Curtsinger, Berger: Coz](https://doi.org/10.1145/2815400.2815409) | 2015, SOSP | Causal profiling | M |
| [Yasin: A top-down method for performance analysis and counters architecture](https://doi.org/10.1109/ispass.2014.6844459) | 2014, ISPASS | Top-down, [20-profiling.md](20-profiling.md) | M |
| [Dean, Barroso: The tail at scale](https://doi.org/10.1145/2408776.2408794) | 2013, CACM | Why p99.99 is a metric | M |
| [Fleming, Wallace: How not to lie with statistics](https://doi.org/10.1145/5666.5673) | 1986, CACM | Geometric mean for ratios | M |

## WG21 papers

Checked against the [wg21.link index](https://wg21.link/index.json); C++26 status against [cppreference](https://en.cppreference.com/w/cpp/compiler_support/26). As of 2026-11.

| Paper | Title, latest revision | Status and use |
|---|---|---|
| [P0260R22](https://wg21.link/P0260) | C++ Concurrent Queues (Vollmann, Crowl, Mysen, Nishanov), 2026-10 | Not in C++26. Align names and close semantics in [04-api.md](04-api.md). Companions: [P4295](https://wg21.link/P4295) single ends, [P3282](https://wg21.link/P3282) static storage |
| [P2530R3](https://wg21.link/P2530) | Hazard Pointers for C++26 | In C++26; no implementation listed on cppreference |
| [P2545R4](https://wg21.link/P2545) | Read-Copy Update (RCU) | In C++26; no implementation listed |
| [P0154R1](https://wg21.link/P0154) | `hardware_{true,false}_sharing_size`; ABI concern in [P1119](https://wg21.link/P1119) | Destructive-size constant |
| [P1135R6](https://wg21.link/P1135) | The C++20 Synchronization Library | `atomic::wait`, [07-waiting.md](07-waiting.md). Fix-ups: [P2616](https://wg21.link/P2616) |
| [P0493R5](https://wg21.link/P0493) | Atomic maximum/minimum | In C++26 |
| [P3111R8](https://wg21.link/P3111) | Atomic Reduction Operations | In C++26 |
| [P2835R7](https://wg21.link/P2835) | Expose `std::atomic_ref`'s object address | In C++26. **Not a pause hint.** Title search of the index found no pause or spin-hint paper |
| [P2135R1](https://wg21.link/P2135) | A Relaxed Guide to `memory_order_relaxed` (McKenney, Boehm, Goldblatt) | Guidance for [05-memory-model.md](05-memory-model.md) |
| [P0668R5](https://wg21.link/P0668) | Revising the C++ memory model | The RC11 fix in the standard |
| [P3475R2](https://wg21.link/P3475) | Defang and deprecate `memory_order::consume` | Never use consume |
| [P1478R8](https://wg21.link/P1478) | Byte-wise atomic memcpy | Seqlock-style payload copy |
| [P0528R3](https://wg21.link/P0528) | Padding bits and atomic compare-and-exchange | CAS on padded structs |
| [P1928R15](https://wg21.link/P1928) | `std::simd` | In C++26, GCC 16 partial. [14-simd.md](14-simd.md) |
| [P2590R2](https://wg21.link/P2590) | Explicit lifetime management | `start_lifetime_as`, [10-raii-and-lifetime.md](10-raii-and-lifetime.md) |
| [P0323R12](https://wg21.link/P0323) | `std::expected` | C++23 result type |
| [P2900R14](https://wg21.link/P2900) | Contracts for C++ | In C++26 |
| [P2786R13](https://wg21.link/P2786) | Trivial Relocatability For C++26 | **Removed** from the C++26 draft at Kona, 2025-11, by [P3920R0](https://wg21.link/P3920). C++29 questions: [P4197R0](https://wg21.link/P4197). Do not depend on it |
| [P0843R14](https://wg21.link/P0843) | `inplace_vector` | In C++26 |

## Claims that later work corrected

| Claim | Corrected by | Source of the correction |
|---|---|---|
| The C++11 model's seq_cst semantics is sound when mixed with weaker orders | Lahav et al. 2017, then P0668 | Titles and P0668; read both for the exact failing cases |
| The C11 model validates common compiler optimisations | Vafeiadis et al. 2015 | Paper title |
| YMC queue is wait-free | Blocks when memory is exhausted | wCQ abstract (read) |
| Fast fetch-and-add rings need double-width CAS | Romanov, Koval 2023 | Paper title |
| High-throughput queues must trade memory for speed | SCQ 2019 | SCQ abstract (read) |
| Trivial relocation ships in C++26 | Removed, P3920R0 | WG21 papers |
| Strict FIFO results and relaxed FIFO results compare | Relaxed designs reorder by contract | BlockFIFO abstract (read) |

## Not included, could not verify in time

USENIX papers without DOIs (BBQ ATC 2022, TCMalloc/Temeraire OSDI 2021, AddressSanitizer ATC 2012, CHESS OSDI 2008), jemalloc (BSDCan 2006), Drepper 2007, Fraser's thesis, Ramalhete-Correia PPoPP 2017 poster, Crystalline DISC 2021, MLGO, local linearizability, Engineering MultiQueues, Frigo et al. FOCS 1999, Adve-Gharachorloo 1996. They exist to the best of our knowledge; they get a row only after someone opens the source.
