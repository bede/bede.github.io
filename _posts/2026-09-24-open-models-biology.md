---
layout: post
title: Asking open models about molecular biology
---

Like many researchers I find that frontier language models often refuse to answer mundane biology questions on grounds of biosecurity. Particularly prior to the launch of Fable, Claude Opus's guardrails were often comically strict. Adding to the frustration, Claude's guardrail sensitivity has historically been erratic, fluctuating even for the same model release. In the same week that it refused test prompts about DNA structure and "what is a k-mer", Opus freely discussed pathogenic virus genomics. The situation has improved, although the recent launch of Opus 5.5 appears to be another step backwards in this regard:

> Opus 5.5 (1M context)'s safeguards flagged this session. You may be seeing this for the
> first time on an Opus model: Opus 5.5 (1M context) is more capable and has stronger
> safeguards as a result, which can sometimes flag biology-research-adjacent work. We're
> improving these safeguards to reduce the amount of incorrectly flagged messages. Opus 5
> is answering instead, or you can edit and retry with Opus 5.5 (1M context). Send
> feedback with /feedback or learn more: https://support.claude.com/en/articles/8106465

In contrast, open-weight models consistently answer my prompts about biology even in stock, unabliterated form. While discussing Opus 5's response to a tricky question about selective lysis yesterday, colleague Josh Quick and I compared the quality of responses with top-ranked open-weight models. Josh is an expert molecular biologist and an ideal judge of answer quality for this question (see below for prompt). Responses were generated using the Pi harness with skills installed for searching and accessing PDFs, using models accessed via OpenRouter. We compared responses from Opus 5 and 5.5 (high reasoning effort) with those from four top-ranked open-weight models according to the Artificial Analysis index at the time of writing. The OpenRouter bill for this was $4.59.

**Prompt (by Josh Quick)** 

> Research the use of Saponin-DNase for selective lysis in clinical metagenomics. I'm interested in the mechanism of action, so focus your research on how Saponin interacts with mammalian cell membranes and why the depletion works best in a high-salt environment. Summarise findings in a markdown file named report.md in the current directory.

## Results

Claude Opus 5.5 refused to answer on biosecurity grounds, its refusal costing nearly half as much as DeepSeek's complete answer. All other models responded, taking between 3 and 27 minutes to complete their research.

| Model | Effort | Human grading | Cost (USD) | Time | Notes |
|---|---|---|---|---|---|
| kimi-k3 | max | 85% | $0.99 | 27m0s | Factual accuracy is high, excellent critical analysis, excellent synthesis |
| deepseek-v4-pro-0813 | max | 85% | $0.05 | 3m27s | Factual accuracy is high, good critical analysis on reported findings, excellent synthesis |
| claude-opus-5 | high | 75% | $2.15 | 7m22s | Factual accuracy is high, critical analysis should have identified inconsistencies in one source, very good synthesis throughout |
| kimi-k3 | high | 75% | $0.61 | 19m9s | Factual accuracy is high, good critical analysis but repeats the cell-free DNA error, excellent synthesis |
| glm-5.3 | max | 75% | $0.36 | 4m34s | Factual accuracy is high, very well structured, critical analysis should have identified inconsistencies in one source, very good synthesis throughout |
| glm-5.3 | high | 70% | $0.30 | 9m10s | Factual accuracy is high, structure needs improvement, only answer to realise that final concentration of digestion buffer is the relevant information |
| mimo-v2.6-pro | high | 70% | $0.07 | 14m7s | Factual accuracy is high, critical analysis should have identified inconsistencies around RNA virus recovery and free-DNA, excellent synthesis. No `max` effort level available |
| deepseek-v4-pro-0813 | high | 70% | $0.04 | 4m1s | Factual accuracy is high, failed to identify the importance of high salt on chromatin disruption |
| claude-opus-5.5 | high | **Refused on biosecurity grounds** | $0.02 | 2s | `stop_reason: refusal`, no refusal category recorded; no `report.md` produced |

**Josh's notes**

- Factual accuracy is always very high
- Most models propose a plausible mechanism (likely correct)
- They often make one of two critical analysis errors, repeating claims from one paper that saponin-based methods cannot detect extracellular DNA (which no method can) or that RNA viruses are not detected (which is incorrect)

## Conclusion

Despite Anthropic's [growing](https://www.anthropic.com/research/agents-in-biology) [interest](https://www.anthropic.com/research/claude-uplifts-biomolecular-modeling) [in biological research](https://www.anthropic.com/news/claude-discovers-novel-enzyme-system), their public models make unreliable assistants for many researchers due to their overly sensitive guardrails. Should your research area be deemed risky by Anthropic's classifier, you will need to find a backup model for any agentic work refused by Claude. In this single example, open models yielded Opus-level answers in less time for a few pence each. We were particularly impressed with the answer from the recent mimo-v2.6-pro model.

