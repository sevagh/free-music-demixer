---
layout: post
title: "PRO site has been launched!"
category: announcements
tags: [demucs, news, pro, ensemble]
header_class: post
description: "We have released 3 new PRO models!"
keywords: music demixing, song splitting, song splitter, stem separation, demucs, pro, ensemble
intro: "Creating ensemble models for better demixing 📈"
---

## Announcing our new PRO site!

Over the course of the last month, we have been hard at work on this project, and we're ready to show you what we came up with!

<img alt="pro-model-comparison" src="/assets/blog/post6/model_comparison.webp" width="75%"/>

Browse and sign up for our [PRO website](https://pro.freemusicdemixer.com) today!

## AI demixing competitions

The [Sound Demixing Challenge 2023](https://www.aicrowd.com/challenges/sound-demixing-challenge-2023), recently wrapped up. It's a continuation of the first [Music Demixing Challenge 2021](https://www.aicrowd.com/challenges/music-demixing-challenge-ismir-2021). These research challenges are hugely important in the field of music demixing. The first hybrid time-frequency Demucs model (v3) was created during MDX 2021.

When the best music demixing and source separation researchers and engineers are in one place and pushing themselves to improve and win cash prizes, the field advances.

## Latest research

The winning teams in the SDX 2023, creators of the [MVSep](https://mvsep.com/en/home) website, [published their paper](https://arxiv.org/abs/2305.07489) on their winning SDX 2023 strategies:

* They use *ensemble models* to combine Demucs and other AI models: that is to say, they run many different AI models and average or combine their outputs to create 1 set of stems for 1 input song
* They use *test-time augmentation*, or inference augmentation, in the form of inverted waveforms

That means that you apply the demixing model to the original song and to the inverted song (`waveform * -1.0`), re-invert the inverted stems output, and now you have two independent and slightly different sets of separated stems for the same song.

## Our PRO models

As part of the new pro release, we are launching with 3 models:
* Karaoke/vocal-only: we apply the Demucs fine-tuned vocal model with test-time inverted waveform augmentation for an exclusive improved vocal separation at **2x inference cost** (the AI is run twice on the input song) for **maximum vocal quality**, <span class="blog-highlight">beating Demucs v4 fine-tuned vocals</span>
* Pro custom model: we start with the Karaoke model, and then follow up with running Demucs 4-source and 6-source twice each on the instrumental output; the end result is **6x inference cost** for a well-rounded model that blends our best vocal performance with improved drums, bass, guitar, and a variety of stems
* Pro fine-tuned model: finally, this is faithful to the original Demucs v4 Fine-tuned model, which has a **4x inference cost** and has <span class="blog-highlight">dramatically better drum and bass performance</span>

## Stay up to date!

Remember to use the promo code `LAUNCH10`, which is valid until March 31 2024, to test-drive the new ensemble models.

Stay tuned for further updates and upcoming models! This is just the beginning.
