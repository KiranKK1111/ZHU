"""PyInstaller entry point for the frozen engine (zhu-engine.exe)."""

import multiprocessing

if __name__ == "__main__":
    multiprocessing.freeze_support()
    from zhu_engine.__main__ import main

    main()
