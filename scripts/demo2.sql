-- mibsql_demo2: a drifted copy of mibsql_demo for the compare tools (run as the mibsql user).
USE mibsql_demo2;
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS customers, products, orders, order_items, audit_log, legacy;
DROP VIEW IF EXISTS v_customer_sales;
CREATE TABLE customers LIKE mibsql_demo.customers;
INSERT INTO customers SELECT * FROM mibsql_demo.customers;
CREATE TABLE products LIKE mibsql_demo.products;
INSERT INTO products SELECT * FROM mibsql_demo.products;
CREATE TABLE orders LIKE mibsql_demo.orders;
INSERT INTO orders SELECT * FROM mibsql_demo.orders WHERE id <= 1000;
SET FOREIGN_KEY_CHECKS = 1;
-- structure drift
ALTER TABLE customers MODIFY name VARCHAR(60) NOT NULL, DROP COLUMN city, ADD COLUMN phone VARCHAR(20) NULL;
ALTER TABLE products DROP INDEX ix_products_name;
CREATE TABLE legacy (id INT PRIMARY KEY, note TEXT);
CREATE VIEW v_customer_sales AS SELECT c.id, c.name FROM customers c;
-- data drift
UPDATE products SET price = price + 1 WHERE id IN (3, 7, 11);
UPDATE products SET attributes = NULL WHERE id = 5;
DELETE FROM products WHERE id IN (100, 101);
INSERT INTO products (id, sku, name, price, stock) VALUES (500, 'ZZ000500', 'Solo in demo2', 9.99, 1);
