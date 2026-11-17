.PHONY: install frontend build test

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

test:
	cd frontend && rm -rf .test-build && npx tsc -p scripts/tsconfig.test.json && node --experimental-strip-types --loader ./scripts/test-loader.mjs .test-build/scripts/test-compensation.js && rm -rf .test-build
