#!/usr/bin/env python3
"""
MedGemma local analysis script.
Loads MedGemma 4B via transformers, analyzes a medical image,
outputs JSON with interpretation, analysis, and report.

Usage:
    python medgemma_analyze.py <image_path> [--context "Modality: CT, Body Part: Chest"]

Requirements:
    pip install transformers torch pillow accelerate
    (First run downloads ~8GB model, cached afterward)
"""

import sys
import json
import argparse
from pathlib import Path

MODEL_ID = "google/medgemma-4b-it"


def detect_device():
    """Pick best available device."""
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_pipeline(device):
    """Load MedGemma pipeline (cached after first download)."""
    import torch
    from transformers import pipeline

    dtype = torch.bfloat16 if device in ("cuda", "mps") else torch.float32

    pipe = pipeline(
        "image-text-to-text",
        model=MODEL_ID,
        torch_dtype=dtype,
        device=device,
    )
    return pipe


def ask(pipe, image_path, prompt):
    """Send a single prompt with the image to MedGemma."""
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "url": image_path},
                {"type": "text", "text": prompt},
            ],
        }
    ]
    output = pipe(text=messages, max_new_tokens=512)
    # Extract assistant response
    generated = output[0]["generated_text"]
    # generated is a list of message dicts; last one is the assistant reply
    if isinstance(generated, list):
        for msg in reversed(generated):
            if msg.get("role") == "assistant":
                return msg.get("content", "").strip()
    # Fallback: return as string
    return str(generated).strip()


def main():
    parser = argparse.ArgumentParser(description="MedGemma local analysis")
    parser.add_argument("image", help="Path to medical image (JPG/PNG)")
    parser.add_argument("--context", default="", help="DICOM metadata context string")
    args = parser.parse_args()

    image_path = Path(args.image).resolve()
    if not image_path.exists():
        print(json.dumps({"error": f"Image not found: {image_path}"}))
        sys.exit(1)

    # Use file:// URL for local images
    image_url = image_path.as_uri()
    context = args.context or "Medical image"

    # Detect device
    device = detect_device()
    print(f"MedGemma: Loading model on {device}...", file=sys.stderr)

    pipe = load_pipeline(device)
    print("MedGemma: Model loaded. Running analysis...", file=sys.stderr)

    prompts = {
        "interpretation": (
            f"You are a medical imaging AI. {context}. "
            "Provide a brief clinical interpretation of this medical image. "
            "Focus on what is visible, any notable findings, and their significance. "
            "Keep it concise (3-5 sentences)."
        ),
        "analysis": (
            f"You are a medical imaging AI. {context}. "
            "Provide a technical analysis of this medical image. "
            "Describe the image quality, positioning, contrast, visible anatomical structures, "
            "and any abnormalities or variants. Keep it concise (4-6 sentences)."
        ),
        "report": (
            f"You are a medical imaging AI. {context}. "
            "Generate a structured radiology-style report for this medical image "
            "with these sections: FINDINGS, IMPRESSION. Be professional and concise."
        ),
    }

    results = {}
    for key, prompt in prompts.items():
        print(f"MedGemma: Generating {key}...", file=sys.stderr)
        try:
            results[key] = ask(pipe, image_url, prompt)
        except Exception as e:
            results[key] = f"Error: {e}"

    output = {
        "model": MODEL_ID,
        "device": device,
        "interpretation": results.get("interpretation", ""),
        "analysis": results.get("analysis", ""),
        "report": results.get("report", ""),
        "context": context,
        "disclaimer": (
            "AI-generated analysis for research purposes only. "
            "Not a clinical diagnosis. Always consult a qualified healthcare professional."
        ),
    }

    # Print JSON to stdout (Node.js reads this)
    print(json.dumps(output))


if __name__ == "__main__":
    main()
