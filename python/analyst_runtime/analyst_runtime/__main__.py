"""`python -m analyst_runtime` 入口。"""

import sys

from .doctor import main

if __name__ == "__main__":
    sys.exit(main())
