// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  ChainCircle - On-chain Rotating Savings and Credit Association (ROSCA)
 * @notice A ROSCA (also known as 标会 / 合会 / tontine / susu / chit fund) is a group of
 *         people who each contribute a fixed amount every round; each round the whole
 *         pot goes to one member, until every member has received the pot once.
 *
 *         The classic problem is TRUST: a member who has already received the pot may
 *         stop paying, or the organiser may run away with the money. ChainCircle removes
 *         the need for trust:
 *           - Funds are held by the contract, never by the organiser.
 *           - Every member locks COLLATERAL when joining.
 *           - If a member misses a payment, anyone can settle the round and the missed
 *             contribution is taken from the defaulter's collateral, so honest members
 *             are still paid.
 *           - Remaining collateral is returned when the circle completes, and every
 *             address builds an on-chain REPUTATION (payments, defaults, completions).
 *
 * @dev    Security design:
 *           - Pull-payment pattern: payouts are credited to `pendingWithdrawals` and
 *             claimed with withdraw(), so a malicious member cannot block a circle.
 *           - Checks-Effects-Interactions + reentrancy guard on the only ETH transfer.
 *           - Explicit state machine (Open -> Active -> Completed / Cancelled).
 *           - Bounded loops (MAX_MEMBERS) to keep gas predictable.
 *           - Custom errors and packed structs for gas efficiency.
 */
contract ChainCircle {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Status {
        Open,       // 0 - recruiting members
        Active,     // 1 - rounds in progress
        Completed,  // 2 - every member received the pot
        Cancelled   // 3 - cancelled by creator before starting
    }

    struct Circle {
        // slot 0
        address creator;
        uint40 roundDuration;
        uint40 roundStart;
        uint8 maxMembers;
        uint8 currentRound;   // 1-based, 0 while Open
        // slot 1
        uint128 contribution; // amount each member pays per round
        uint128 collateral;   // amount each member locks when joining
        // slot 2
        Status status;
        uint8 paidCount;      // members who paid in the current round
        uint40 createdAt;
        uint128 pot;          // ETH collected in the current round
        // slot 3+
        string name;
    }

    struct Member {
        bool joined;
        bool received;          // already received a pot
        uint8 defaults;         // missed payments in this circle
        uint128 collateralLeft; // collateral still locked
    }

    struct Reputation {
        uint32 circlesJoined;
        uint32 circlesCompleted; // completed with zero defaults
        uint32 onTimePayments;
        uint32 defaults;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint8 public constant MIN_MEMBERS = 2;
    uint8 public constant MAX_MEMBERS = 12;
    uint256 public constant MIN_CONTRIBUTION = 0.0001 ether;
    uint256 public constant MIN_ROUND_DURATION = 2 minutes; // short enough for a live demo
    uint256 public constant MAX_ROUND_DURATION = 30 days;
    uint256 public constant MAX_NAME_LENGTH = 40;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    uint256 public circleCount;
    mapping(uint256 => Circle) private circles;
    mapping(uint256 => address[]) private circleMembers; // join order = payout order
    mapping(uint256 => mapping(address => Member)) private members;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) private paid; // circle => round => member
    mapping(address => uint256[]) private userCircles;
    mapping(address => Reputation) private reputations;
    mapping(address => uint256) public pendingWithdrawals;

    uint256 private locked = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event CircleCreated(uint256 indexed circleId, address indexed creator, string name, uint256 contribution, uint256 collateral, uint8 maxMembers, uint256 roundDuration);
    event MemberJoined(uint256 indexed circleId, address indexed member, uint256 position);
    event MemberLeft(uint256 indexed circleId, address indexed member);
    event CircleStarted(uint256 indexed circleId, uint256 startTime);
    event ContributionMade(uint256 indexed circleId, uint256 indexed round, address indexed member, uint256 amount);
    event DefaultCovered(uint256 indexed circleId, uint256 indexed round, address indexed member, uint256 slashed);
    event RoundSettled(uint256 indexed circleId, uint256 indexed round, address indexed recipient, uint256 amount);
    event CircleCompleted(uint256 indexed circleId);
    event CircleCancelled(uint256 indexed circleId);
    event Withdrawal(address indexed account, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error InvalidName();
    error InvalidMemberCount();
    error InvalidRoundDuration();
    error ContributionTooSmall();
    error CollateralTooSmall();
    error AmountTooLarge();
    error CircleNotFound();
    error WrongStatus(Status current);
    error AlreadyMember();
    error NotMember();
    error NotCreator();
    error CreatorCannotLeave();
    error WrongAmount(uint256 expected);
    error AlreadyPaid();
    error RoundExpired();
    error RoundNotExpired();
    error NothingToWithdraw();
    error TransferFailed();
    error Reentrancy();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier exists(uint256 circleId) {
        if (circleId == 0 || circleId > circleCount) revert CircleNotFound();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    // ---------------------------------------------------------------------
    // Circle lifecycle
    // ---------------------------------------------------------------------

    /**
     * @notice Create a circle. The creator joins automatically as member #1 and
     *         must send exactly the collateral amount (msg.value).
     * @param name           Display name, 1-40 bytes.
     * @param contribution   ETH each member pays per round (wei).
     * @param maxMembers     Number of members = number of rounds (2-12).
     * @param roundDuration  Seconds each member has to pay in a round.
     */
    function createCircle(
        string calldata name,
        uint128 contribution,
        uint8 maxMembers,
        uint40 roundDuration
    ) external payable returns (uint256 circleId) {
        uint256 nameLen = bytes(name).length;
        if (nameLen == 0 || nameLen > MAX_NAME_LENGTH) revert InvalidName();
        if (maxMembers < MIN_MEMBERS || maxMembers > MAX_MEMBERS) revert InvalidMemberCount();
        if (roundDuration < MIN_ROUND_DURATION || roundDuration > MAX_ROUND_DURATION) revert InvalidRoundDuration();
        if (contribution < MIN_CONTRIBUTION) revert ContributionTooSmall();
        if (msg.value > type(uint128).max) revert AmountTooLarge();
        if (msg.value < contribution) revert CollateralTooSmall();

        unchecked {
            circleId = ++circleCount;
        }

        Circle storage c = circles[circleId];
        c.creator = msg.sender;
        c.roundDuration = roundDuration;
        c.maxMembers = maxMembers;
        c.contribution = contribution;
        c.collateral = uint128(msg.value);
        c.status = Status.Open;
        c.createdAt = uint40(block.timestamp);
        c.name = name;

        emit CircleCreated(circleId, msg.sender, name, contribution, msg.value, maxMembers, roundDuration);
        _join(circleId, c, msg.sender);
    }

    /// @notice Join an open circle by locking exactly the collateral amount.
    function joinCircle(uint256 circleId) external payable exists(circleId) {
        Circle storage c = circles[circleId];
        if (c.status != Status.Open) revert WrongStatus(c.status);
        if (members[circleId][msg.sender].joined) revert AlreadyMember();
        if (msg.value != c.collateral) revert WrongAmount(c.collateral);

        _join(circleId, c, msg.sender);
    }

    /// @notice Leave a circle before it starts; collateral becomes withdrawable.
    function leaveCircle(uint256 circleId) external exists(circleId) {
        Circle storage c = circles[circleId];
        if (c.status != Status.Open) revert WrongStatus(c.status);
        if (!members[circleId][msg.sender].joined) revert NotMember();
        if (msg.sender == c.creator) revert CreatorCannotLeave();

        uint256 refund = members[circleId][msg.sender].collateralLeft;
        delete members[circleId][msg.sender];

        // Remove while preserving join order (it is the payout order). Bounded by MAX_MEMBERS.
        address[] storage list = circleMembers[circleId];
        uint256 len = list.length;
        for (uint256 i; i < len; ++i) {
            if (list[i] == msg.sender) {
                for (uint256 j = i; j + 1 < len; ++j) {
                    list[j] = list[j + 1];
                }
                list.pop();
                break;
            }
        }

        pendingWithdrawals[msg.sender] += refund;
        emit MemberLeft(circleId, msg.sender);
    }

    /// @notice Creator cancels a circle that has not started; all collateral is refunded.
    function cancelCircle(uint256 circleId) external exists(circleId) {
        Circle storage c = circles[circleId];
        if (msg.sender != c.creator) revert NotCreator();
        if (c.status != Status.Open) revert WrongStatus(c.status);

        c.status = Status.Cancelled;
        address[] storage list = circleMembers[circleId];
        for (uint256 i; i < list.length; ++i) {
            Member storage m = members[circleId][list[i]];
            pendingWithdrawals[list[i]] += m.collateralLeft;
            m.collateralLeft = 0;
        }
        emit CircleCancelled(circleId);
    }

    // ---------------------------------------------------------------------
    // Rounds
    // ---------------------------------------------------------------------

    /// @notice Pay this round's contribution. The last payment settles the round automatically.
    function contribute(uint256 circleId) external payable exists(circleId) {
        Circle storage c = circles[circleId];
        if (c.status != Status.Active) revert WrongStatus(c.status);
        if (!members[circleId][msg.sender].joined) revert NotMember();
        if (block.timestamp > uint256(c.roundStart) + c.roundDuration) revert RoundExpired();
        uint256 round = c.currentRound;
        if (paid[circleId][round][msg.sender]) revert AlreadyPaid();
        if (msg.value != c.contribution) revert WrongAmount(c.contribution);

        paid[circleId][round][msg.sender] = true;
        unchecked {
            c.paidCount += 1;
            reputations[msg.sender].onTimePayments += 1;
        }
        c.pot += uint128(msg.value);

        emit ContributionMade(circleId, round, msg.sender, msg.value);

        if (c.paidCount == c.maxMembers) {
            _settleRound(circleId, c);
        }
    }

    /**
     * @notice After the round deadline, anyone can settle the round. Missing
     *         contributions are covered from the defaulters' collateral.
     */
    function settleRound(uint256 circleId) external exists(circleId) {
        Circle storage c = circles[circleId];
        if (c.status != Status.Active) revert WrongStatus(c.status);
        if (block.timestamp <= uint256(c.roundStart) + c.roundDuration) revert RoundNotExpired();

        _settleRound(circleId, c);
    }

    /// @notice Withdraw payouts and returned collateral (pull-payment pattern).
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        pendingWithdrawals[msg.sender] = 0; // effect before interaction
        emit Withdrawal(msg.sender, amount);

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getCircle(uint256 circleId) external view exists(circleId) returns (Circle memory) {
        return circles[circleId];
    }

    /// @notice Members in payout order.
    function getMembers(uint256 circleId) external view exists(circleId) returns (address[] memory) {
        return circleMembers[circleId];
    }

    function getMember(uint256 circleId, address account) external view returns (Member memory) {
        return members[circleId][account];
    }

    /// @notice Members of the circle and whether each has paid in the current round.
    function getRoundStatus(uint256 circleId)
        external
        view
        exists(circleId)
        returns (address[] memory list, bool[] memory paidFlags)
    {
        list = circleMembers[circleId];
        paidFlags = new bool[](list.length);
        uint256 round = circles[circleId].currentRound;
        for (uint256 i; i < list.length; ++i) {
            paidFlags[i] = paid[circleId][round][list[i]];
        }
    }

    function hasPaid(uint256 circleId, uint256 round, address account) external view returns (bool) {
        return paid[circleId][round][account];
    }

    function roundDeadline(uint256 circleId) external view exists(circleId) returns (uint256) {
        Circle storage c = circles[circleId];
        if (c.status != Status.Active) return 0;
        return uint256(c.roundStart) + c.roundDuration;
    }

    function getUserCircles(address account) external view returns (uint256[] memory) {
        return userCircles[account];
    }

    function getReputation(address account) external view returns (Reputation memory) {
        return reputations[account];
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _join(uint256 circleId, Circle storage c, address account) private {
        members[circleId][account] = Member({
            joined: true,
            received: false,
            defaults: 0,
            collateralLeft: uint128(msg.value)
        });
        circleMembers[circleId].push(account);
        userCircles[account].push(circleId);

        uint256 count = circleMembers[circleId].length;
        emit MemberJoined(circleId, account, count);

        if (count == c.maxMembers) {
            c.status = Status.Active;
            c.currentRound = 1;
            c.roundStart = uint40(block.timestamp);
            address[] storage list = circleMembers[circleId];
            for (uint256 i; i < count; ++i) {
                unchecked {
                    reputations[list[i]].circlesJoined += 1;
                }
            }
            emit CircleStarted(circleId, block.timestamp);
        }
    }

    function _settleRound(uint256 circleId, Circle storage c) private {
        address[] storage list = circleMembers[circleId];
        uint256 len = list.length;
        uint256 round = c.currentRound;
        uint256 pot = c.pot;

        // Cover every missed payment from the defaulter's collateral.
        if (c.paidCount < len) {
            uint256 contribution = c.contribution;
            for (uint256 i; i < len; ++i) {
                address account = list[i];
                if (paid[circleId][round][account]) continue;

                Member storage m = members[circleId][account];
                uint256 slash = m.collateralLeft < contribution ? m.collateralLeft : contribution;
                m.collateralLeft -= uint128(slash);
                unchecked {
                    m.defaults += 1;
                    reputations[account].defaults += 1;
                }
                pot += slash;
                emit DefaultCovered(circleId, round, account, slash);
            }
        }

        // Pay the pot to this round's recipient (join order).
        address recipient = list[round - 1];
        members[circleId][recipient].received = true;
        pendingWithdrawals[recipient] += pot;
        emit RoundSettled(circleId, round, recipient, pot);

        c.pot = 0;
        c.paidCount = 0;

        if (round == len) {
            c.status = Status.Completed;
            for (uint256 i; i < len; ++i) {
                Member storage m = members[circleId][list[i]];
                pendingWithdrawals[list[i]] += m.collateralLeft;
                m.collateralLeft = 0;
                if (m.defaults == 0) {
                    unchecked {
                        reputations[list[i]].circlesCompleted += 1;
                    }
                }
            }
            emit CircleCompleted(circleId);
        } else {
            unchecked {
                c.currentRound = uint8(round + 1);
            }
            c.roundStart = uint40(block.timestamp);
        }
    }
}
