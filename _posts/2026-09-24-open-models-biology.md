---
layout: post
title: Asking open models about molecular biology
---

Like many researchers I find that frontier language models often refuse to answer [mundane biology questions](https://bsky.app/profile/bede.im/post/3ly4274dnks2g) on grounds of biosecurity. Particularly prior to the launch of Fable, Claude Opus's guardrails could be comically strict. Adding to frustration, Claude's guardrail sensitivity is erratic, fluctuating even for the same model release. In the same week that it refused test prompts about DNA structure and "what is a *k*-mer?", Opus freely discussed pathogenic virus genomics. The situation has improved, although Opus 5.5 appears to be a step backwards:

> Opus 5.5 (1M context)'s safeguards flagged this session. You may be seeing this for the
> first time on an Opus model: **Opus 5.5 (1M context) is more capable and has stronger**
> **safeguards as a result**, which can sometimes flag biology-research-adjacent work. 
> …

In contrast, open-weight models consistently answer my prompts about biology even in stock, unabliterated form. While discussing Opus 5's response to a tricky question about selective lysis yesterday, colleague [Joshua Quick](https://www.birmingham.ac.uk/staff/profiles/biosciences/quick-joshua) and I compared the quality of responses with top-ranked open-weight models. Josh is an expert molecular biologist with a deep understanding of this topic, making him an ideal judge. Responses were generated using the Pi harness with skills installed for searching and accessing PDFs, using models accessed via OpenRouter. We compared responses from Opus 5 and 5.5 (high reasoning effort) with those from four top-ranked open-weight models according to the Artificial Analysis index at the time of writing. The OpenRouter bill for this was $4.59.

**Prompt**

> *Research the use of Saponin-DNase for selective lysis in clinical metagenomics. I'm interested in the mechanism of action, so focus your research on how Saponin interacts with mammalian cell membranes and why the depletion works best in a high-salt environment. Summarise findings in a markdown file named report.md in the current directory.*

## Results

**Claude Opus 5.5 refused to answer on biosecurity grounds, its refusal costing half that of DeepSeek's complete answer.** All other models responded, taking between 3 and 27 minutes to complete their research. With maximum reasoning effort, both Kimi K3 and Deepseek V4 Pro generated better answers than Opus 5. While Kimi K3 took considerably longer than other models and cost almost half that of Opus 5, DeepSeek V4 Pro rapidly generated a top-scoring answer in an order of magnitude less time for just $0.05 – two percent of the cost of Opus 5 here.

| Model | Effort | Human grading | Cost | Time | Notes |
|---|---|---|---|---|---|
| kimi-k3 | max | **85%** | $0.99 | 27m0s | Factual accuracy is high, excellent critical analysis, excellent synthesis |
| deepseek-v4-pro-0813 | max | **85%** | $0.05 | **3m27s** | Factual accuracy is high, good critical analysis on reported findings, excellent synthesis |
| claude-opus-5 | high | 75% | $2.15 | 7m22s | Factual accuracy is high, critical analysis should have identified inconsistencies in one source, very good synthesis throughout |
| kimi-k3 | high | 75% | $0.61 | 19m9s | Factual accuracy is high, good critical analysis but repeats an error around cell-free DNA, excellent synthesis |
| glm-5.3 | max | 75% | $0.36 | 4m34s | Factual accuracy is high, very well structured, critical analysis should have identified inconsistencies in one source, very good synthesis throughout |
| glm-5.3 | high | 70% | $0.30 | 9m10s | Factual accuracy is high, structure needs improvement, only answer to report final concentration of digestion buffer as the relevant condition |
| mimo-v2.6-pro | high | 70% | $0.07 | 14m7s | Factual accuracy is high, critical analysis should have identified inconsistencies around RNA virus recovery and free-DNA, excellent synthesis. No `max` effort level available |
| deepseek-v4-pro-0813 | high | 60% | $0.04 | 4m1s | Factual accuracy is high, failed to identify the importance of high salt on chromatin disruption |
| claude-opus-5.5 | high | **Refused on biosecurity grounds** | $0.02 |  | Soap is more dangerous than we previously thought?! |

**Notes**

- Factual accuracy is always very high
- Most models reason their way to a plausible mechanism (likely correct)
- They often make one of two critical analysis errors, repeating claims that saponin-based methods cannot detect extracellular DNA (which no method can in practice due to the abundance paradox) or that RNA viruses cannot be detected citing a study that had no RNA arm.

## Conclusion

Despite Anthropic's [growing](https://www.anthropic.com/research/agents-in-biology) [interest](https://www.anthropic.com/research/claude-uplifts-biomolecular-modeling) [in biological research](https://www.anthropic.com/news/claude-discovers-novel-enzyme-system), their current public models make unreliable assistants for many researchers due to overly sensitive guardrails. Should your research topic be deemed risky by Anthropic's classifier, you will need to find an alternative model to complete agentic tasks refused by Claude.

In this single example, open-weight models yielded Opus-quality answers in less time for a few pennies each. Top open-weight models are all capable of complex reasoning and synthesising information from different scientific fields into a cohesive answer. One of the reasons we chose this question is that there is little published on the mechanism and the mechanism itself is counterintuitive, with high salt resulting in lysis via the colloid-osmosis effect. Good answers also correlate sterol richness in different taxa with depletion biases observed in different studies. All models tested performed outstandingly well in terms of factual accuracy and proposing a valid mechanism, with the main differentiator being the ability to critically analyse conflicting information, likely due to the complicated landscape of methods and sequencing modalities or the scarcity of published studies. 

*Bede Constantinides &amp; Joshua Quick*

