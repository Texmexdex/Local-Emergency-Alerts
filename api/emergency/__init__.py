"""Local emergency situation assessment for the Houston / Ship Channel area.

Each source module (``nws``, ``caer``, ``houston``) fetches and normalizes one
public feed. ``assess`` combines them into a single answer to the question
"is something happening near me right now, and what should I do?".
"""
